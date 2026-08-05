'use strict';

/**
 * Telegram-розсилка для дозамовлень (§15).
 *
 * Що надсилається:
 *   • приватне повідомлення КОЖНОМУ продавцю магазинів цільової групи;
 *   • пост у сервісні Telegram-групи.
 *
 * Куди йде груповий пост: у наявний список «Групи бота» (telegram.allowedGroupIds) —
 * рішення власника 05.08.2026. Спека (§15, §25) рекомендувала завести окремий
 * список сервісних груп; свідомо НЕ робимо, щоб не плодити третій список.
 * Наслідок, який варто пам'ятати: цей же список дає право реєстрації, тож нова
 * група для розсилки автоматично стає групою, з якої можна зареєструватися.
 *
 * ГРАФІК (адаптивний, рішення власника — рекомендація §15):
 *   вікно ≤ 30 хв: одразу → за 5 хв до закриття → після заморозки
 *   вікно > 30 хв: одразу → посередині → за 10 хв до закриття → після заморозки
 *
 * ІДЕМПОТЕНТНІСТЬ (§21, тест 18): кожен тип повідомлення «забирається» атомарним
 * findOneAndUpdate з фільтром notifiedTypes:{$ne:type}. Рестарт сервера, другий
 * воркер чи повторний тік планувальника не можуть надіслати те саме двічі.
 *
 * АНТИСПАМ: одна хвиля (накладна з кількома позиціями × кілька груп) дає ОДНЕ
 * повідомлення на групу зі списком товарів, а не по повідомленню на товар.
 */

const User  = require('../models/User');
const Shop  = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const SupplementOffer = require('../models/SupplementOffer');
const { loadProductsFor, productView } = require('./supplementOffers');

const NOTIFY_TYPES = ['opened', 'mid', 'soon', 'frozen'];

// Telegram обмежує розсилку різним користувачам приблизно 30 повідомленнями за
// секунду. Група з 30 магазинів — це рівно межа, а вона ще й ділиться з рештою
// бота. 40 мс між надсиланнями тримають ~25/с і додають до всієї хвилі близько
// секунди. sendMessageWithRetry уміє відпрацювати 429, але дешевше в нього не
// впиратись: під час ретраю продавці чекають на повідомлення про вікно, яке
// живе лічені хвилини.
const SEND_GAP_MS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Межа, за якою вікно вважається «довгим» і отримує додаткове нагадування
// посередині. Нижче неї на середину часу просто немає.
const LONG_WINDOW_MINUTES = 30;

/** Warsaw HH:MM — той самий формат, що й скрізь у повідомленнях бота. */
function fmtTime(date) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date));
}

function minutesLeft(closesAt, now = new Date()) {
  return Math.max(0, Math.round((new Date(closesAt).getTime() - now.getTime()) / 60000));
}

/**
 * Коли має піти нагадування типу `type` для цієї пропозиції.
 * @returns {Date|null} null — цей тип для такого вікна не передбачений.
 */
function dueAtFor(offer, type) {
  const opened = new Date(offer.openedAt).getTime();
  const closes = new Date(offer.closesAt).getTime();
  const windowMs = closes - opened;
  const windowMinutes = windowMs / 60000;

  if (type === 'opened') return new Date(opened);
  if (type === 'mid') {
    if (windowMinutes <= LONG_WINDOW_MINUTES) return null;
    return new Date(opened + windowMs / 2);
  }
  if (type === 'soon') {
    const leadMs = (windowMinutes > LONG_WINDOW_MINUTES ? 10 : 5) * 60 * 1000;
    const due = closes - leadMs;
    // Вікно коротше за випередження — «за 5 хв» збіглося б зі стартовим
    // повідомленням. Тоді нагадування просто немає.
    if (due <= opened) return null;
    return new Date(due);
  }
  return null; // 'frozen' керується подією заморозки, не часом
}

/**
 * Атомарно «забрати» право надіслати цей тип для набору пропозицій.
 * @returns {Promise<Array>} лише ті пропозиції, які саме ЦЕЙ виклик застовпив.
 */
async function claimNotification(offers, type) {
  const claimed = [];
  for (const offer of offers) {
    const updated = await SupplementOffer.findOneAndUpdate(
      { _id: offer._id, notifiedTypes: { $ne: type } },
      { $addToSet: { notifiedTypes: type } },
      { new: true },
    );
    if (updated) claimed.push(offer);
  }
  return claimed;
}

/**
 * Повернути застовплене право назад, якщо надіслати НЕ вдалося.
 *
 * Позначка ставиться ДО надсилання (щоб два воркери не задублювали пост), але
 * без цього відкоту вона перетворювала збій на вічну тишу: бот ще не піднявся,
 * Telegram лежав п'ять секунд, процес упав — і повідомлення про відкрите вікно
 * не піде вже ніколи, бо notifiedTypes каже «надіслано». Для вікна, що живе 30
 * хвилин, це означає, що магазини просто не дізнаються про товар.
 *
 * Ризик зворотного боку — рідкісний дубль, якщо збій стався ПІСЛЯ доставки
 * частини повідомлень. Дубль у Telegram нешкідливий; мовчання — ні.
 */
async function releaseNotification(offers, type) {
  if (!offers?.length) return;
  await SupplementOffer.updateMany(
    { _id: { $in: offers.map((o) => o._id) } },
    { $pull: { notifiedTypes: type } },
  );
}

/** Продавці (та адміни, прив'язані до магазину) цільової групи. */
async function sellersOfGroup(deliveryGroupId) {
  const shops = await Shop.find(
    { deliveryGroupId: String(deliveryGroupId), isActive: true },
    '_id',
  ).lean();
  if (!shops.length) return [];
  return User.find(
    {
      role: { $in: ['seller', 'admin'] },
      shopId: { $in: shops.map((s) => s._id) },
      botBlocked: { $ne: true },
    },
    'telegramId',
  ).lean();
}

async function serviceGroupChatIds() {
  try {
    const { getAllowedGroupIds } = require('../routes/admin');
    return await getAllowedGroupIds();
  } catch (err) {
    console.warn('[supplement/notify] не вдалося прочитати список груп:', err.message);
    return [];
  }
}

function productLines(offers, productMap) {
  return offers.map((o) => {
    const view = productView(productMap.get(String(o.productId)));
    const price = Number(view.price || 0);
    return price > 0 ? `• ${view.title} — ${price.toFixed(2)} zł` : `• ${view.title}`;
  });
}

function buildText(type, { groupName, offers, productMap, now }) {
  const closesAt = offers[0]?.closesAt;
  const lines = productLines(offers, productMap);
  const head = groupName ? `Дозамовлення — ${groupName}` : 'Дозамовлення';

  if (type === 'opened') {
    return [
      `🆕 ${head}`,
      '',
      ...lines,
      '',
      `Замовити можна до ${fmtTime(closesAt)} (${minutesLeft(closesAt, now)} хв).`,
      'Відкрийте додаток → «Товари» — картки позначені бейджем «Дозамовлення».',
    ].join('\n');
  }
  if (type === 'mid' || type === 'soon') {
    return [
      `⏳ ${head} — лишилось ${minutesLeft(closesAt, now)} хв`,
      '',
      ...lines,
      '',
      `Приймаємо до ${fmtTime(closesAt)}.`,
    ].join('\n');
  }
  // frozen
  return [
    `🔒 ${head} — закрито`,
    '',
    ...lines,
    '',
    'Змінити або додати заявку вже не можна. Склад пакує те, що встигли замовити.',
  ].join('\n');
}

/**
 * Розіслати один тип повідомлення для набору пропозицій ОДНІЄЇ хвилі.
 * Групує за deliveryGroupId, шле одне повідомлення на групу.
 *
 * Best-effort: жодна помилка Telegram не має ламати проведення накладної або
 * тік планувальника, тому все загорнуте в try/catch і лише логується.
 */
async function notifyOffers(offers, type, { now = new Date() } = {}) {
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`supplementNotify: невідомий тип '${type}'`);
  if (!offers?.length) return { sentPrivate: 0, sentGroups: 0 };

  const claimed = await claimNotification(offers, type);
  if (!claimed.length) return { sentPrivate: 0, sentGroups: 0 };

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    // Бот ще не піднявся (старт процесу / перевипуск токена). Відпускаємо
    // право — наступний тік планувальника спробує ще раз.
    console.warn('[supplement/notify] бот не піднятий — повідомлення відкладено');
    await releaseNotification(claimed, type);
    return { sentPrivate: 0, sentGroups: 0 };
  }
  // sendMessageWithRetry сам обробляє 429 і позначає користувачів, що
  // заблокували бота — тому шлемо через нього, а не через bot.sendMessage.
  const { sendMessageWithRetry } = require('../telegramBot');

  let productMap;
  try {
    productMap = await loadProductsFor(claimed);
  } catch (err) {
    // Не змогли навіть зібрати текст — нічого не надіслано, право віддаємо.
    console.error('[supplement/notify] підготовка повідомлення впала:', err?.message);
    await releaseNotification(claimed, type);
    throw err;
  }

  const byGroup = new Map();
  for (const o of claimed) {
    const gid = String(o.deliveryGroupId);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(o);
  }

  const groupDocs = await DeliveryGroup.find({ _id: { $in: [...byGroup.keys()] } }, 'name').lean();
  const groupNameById = new Map(groupDocs.map((g) => [String(g._id), g.name || '']));

  const chatIds = await serviceGroupChatIds();

  let sentPrivate = 0;
  let sentGroups = 0;

  for (const [groupId, groupOffers] of byGroup) {
    const text = buildText(type, {
      groupName: groupNameById.get(groupId) || '',
      offers: groupOffers,
      productMap,
      now,
    });

    const sellers = await sellersOfGroup(groupId);
    for (const seller of sellers) {
      try {
        await sendMessageWithRetry(seller.telegramId, text);
        sentPrivate += 1;
      } catch (err) {
        console.warn('[supplement/notify] приватне повідомлення', seller.telegramId, 'не доставлено:', err.message);
      }
      await sleep(SEND_GAP_MS);
    }

    for (const chatId of chatIds) {
      try {
        await sendMessageWithRetry(chatId, text);
        sentGroups += 1;
      } catch (err) {
        console.warn('[supplement/notify] пост у групу', chatId, 'не доставлено:', err.message);
      }
    }
  }

  console.log(`[supplement/notify] ${type}: ${claimed.length} пропозицій → ${sentPrivate} продавцям, ${sentGroups} у групи`);
  return { sentPrivate, sentGroups };
}

/**
 * Які повідомлення вже мали піти, але ще не пішли. Викликається планувальником
 * на кожному тіку.
 *
 * `opened` тут НЕ зайве. Стартовий пост шле проведення накладної, але воно може
 * не встигнути: бот ще не піднявся, Telegram відповів помилкою, процес упав між
 * створенням пропозицій і розсилкою. Разом із releaseNotification це означає, що
 * пропущений старт добʼється на наступному тіку — поки вікно ще відкрите і в
 * цьому ще є сенс. Без нього магазини просто не дізнавалися б про товар.
 */
async function findDueReminders(now = new Date()) {
  const open = await SupplementOffer.find(
    { status: 'open' },
    '_id productId deliveryGroupId openedAt closesAt notifiedTypes',
  ).lean();

  const due = { opened: [], mid: [], soon: [] };
  for (const offer of open) {
    for (const type of ['opened', 'mid', 'soon']) {
      if ((offer.notifiedTypes || []).includes(type)) continue;
      const dueAt = dueAtFor(offer, type);
      if (!dueAt || dueAt.getTime() > now.getTime()) continue;
      due[type].push(offer);
    }
  }
  return due;
}

module.exports = {
  NOTIFY_TYPES,
  LONG_WINDOW_MINUTES,
  notifyOffers,
  findDueReminders,
  dueAtFor,
};
