'use strict';

/**
 * «Замовлення відкрито» — розсилка на старті вікна замовлень групи доставки.
 *
 * Два адресати, один привід:
 *   - робочі Telegram-чати (спільний плоский список) — пост НАЗИВАЄ групу, бо
 *     чат один на всіх, і продавці інших груп мають розуміти, що це не їм;
 *   - приватка кожному продавцю цієї групи — короткий текст лише з дедлайном,
 *     бо людина вже знає, у якій вона групі.
 *
 * Захист від дублів — `OrderingSession.openNotifiedAt`: планувальник тікає
 * щохвилини, і право слати отримує тільки той тік, який атомарно перевів поле
 * з null у дату. Одна сесія = одна розсилка, скільки б процесів не крутилось.
 */

const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const {
  isOrderingOpen,
  getWindowDescription,
  getOrderingWindowOpenAt,
  getOpenDateWarsaw,
  getSessionDeliveryDate,
  DAY_FULL_UK,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup, serviceGroupChatIds } = require('../utils/groupRecipients');

// Пауза між приватними повідомленнями. Те саме значення, що в дозамовленнях:
// Telegram ріже приблизно на 30 msg/s, 40 мс дає запас і не розтягує розсилку
// (100 продавців ≈ 4 секунди).
const SEND_GAP_MS = 40;

// Наскільки пізно ще має сенс казати «замовлення відкрито». Якщо сервер лежав
// або деплоївся довше — сесію мовчки пропускаємо назавжди (openNotifiedAt так і
// лишиться null, наступного тіку вона знову не пройде цю перевірку). Свідомий
// вибір: повідомлення «старт замовлень», надіслане за годину до закриття вікна,
// дезорієнтує сильніше, ніж його відсутність. Це ж правило гасить залп на
// першому деплої цієї фічі: вікна, відкриті раніше, нікого не розбудять.
const MAX_LATENESS_MS = 2 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Чи вікно відкрилось достатньо недавно, щоб про це ще варто було писати.
 *
 * Опорна точка — ОБЧИСЛЕНИЙ момент відкриття з поточного розкладу, а не
 * `OrderingSession.openAt`. Збережене поле пишеться при створенні сесії тодішнім
 * розкладом і застаріває, щойно адмін зсуне години: сесія лишається та сама
 * (її ідентичність — openDate), а openAt починає показувати на момент, якого
 * вже немає. Спіймано наживо: розклад зсунули з 16:30 на 03:30, `now - openAt`
 * вийшло ВІД'ЄМНИМ (відкриття «через 3.7 години»), і перевірка на запізнення
 * пропустила давно відкрите вікно. getOrderingWindowOpenAt завжди повертає
 * найближче МИНУЛЕ відкриття і рахується з того самого розкладу, що й
 * isOrderingOpen — розійтись вони не можуть.
 */
function isFreshOpen(openedAt, now) {
  const elapsed = now.getTime() - openedAt.getTime();
  return elapsed >= 0 && elapsed <= MAX_LATENESS_MS;
}

/**
 * Пряме посилання на Mini App. Джерело — те саме налаштування, що й у
 * дозамовленнях (адмін вписує його в Налаштуваннях). Якщо воно не заповнене,
 * повідомлення йде без посилання: текст самодостатній, і мовчати через
 * відсутній URL було б гірше, ніж надіслати без нього.
 */
async function miniAppLink() {
  try {
    const { appUrl } = await getSupplementSettings();
    return appUrl || '';
  } catch (err) {
    return '';
  }
}

/**
 * «понеділок, 17.08» — physical delivery date for this session. The delivery
 * weekday is independent from the ordering close weekday.
 */
function deliveryDateLabel(dayOfWeek, schedule, now = new Date()) {
  const openDate = getOpenDateWarsaw(schedule, now);
  const deliveryDate = getSessionDeliveryDate(openDate, dayOfWeek, schedule);
  const [, month, day] = deliveryDate.split('-');
  return `${DAY_FULL_UK[dayOfWeek]}, ${day}.${month}`;
}

/** «завтра о 07:30» / «сьогодні о 07:30» / «в четвер о 07:30». */
function closePhrase(window) {
  return `${window.closeLabel} о ${window.closeTime}`;
}

function buildGroupText({ groupName, deliveryLabel, closeLabel, appUrl }) {
  const name = groupName || 'Група доставки';
  return [
    '🟢',
    `Замовлення відкрито — ${name}`,
    '',
    `Доставка — ${deliveryLabel}.`,
    `Замовлення закриються ${closeLabel}.`,
    '',
    'Відкрийте додаток → «Товари» і зробіть замовлення.',
    appUrl,
  ].filter((line) => line !== '').join('\n');
}

function buildPrivateText({ closeLabel, appUrl }) {
  return [
    '🟢',
    'Замовлення відкрито',
    '',
    `Закриються ${closeLabel}.`,
    '',
    'Відкрийте додаток → «Товари» і зробіть замовлення.',
    appUrl,
  ].filter((line) => line !== '').join('\n');
}

/**
 * Атомарно займає сесію під розсилку. Повертає true лише тому викликачу, який
 * реально перевів openNotifiedAt з null у дату.
 *
 * `openNotifiedAt: null` у фільтрі матчить і null, і відсутнє поле — тому сесії,
 * створені до появи цього поля, обробляються без міграції.
 */
async function claimSession(sessionId, now) {
  const claimed = await OrderingSession.findOneAndUpdate(
    { _id: sessionId, openNotifiedAt: null },
    { $set: { openNotifiedAt: now } },
    { new: true },
  ).lean();
  return Boolean(claimed);
}

/** Telegram не прийняв жодного повідомлення — віддаємо сесію наступному тіку. */
async function releaseSession(sessionId) {
  await OrderingSession.updateOne({ _id: sessionId }, { $set: { openNotifiedAt: null } });
}

async function notifyOrderingOpen({ now = new Date() } = {}) {
  const { getBot, sendMessageWithRetry } = require('../telegramBot');
  if (!getBot()) return { notifiedGroups: 0, sentPrivate: 0, sentGroups: 0 };

  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule').lean();

  let notifiedGroups = 0;
  let sentPrivate = 0;
  let sentGroups = 0;
  let chatIds = null; // читаємо лише якщо реально є що слати

  for (const group of groups) {
    const status = isOrderingOpen(group.orderingSchedule, now);
    if (!status.isOpen) continue;
    if (!isFreshOpen(getOrderingWindowOpenAt(group.orderingSchedule, now), now)) continue;

    const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
    if (!sessionId) continue; // maintenance-режим: сесій не створюємо

    const session = await OrderingSession.findById(sessionId, 'openNotifiedAt').lean();
    if (!session || session.openNotifiedAt) continue;

    // Група без жодного живого продавця — це конфігураційний артефакт, а не
    // адресат: поста в спільний чат про неї теж не робимо.
    const sellers = await sellersOfGroup(String(group._id));
    if (!sellers.length) continue;

    if (!await claimSession(sessionId, now)) continue;

    const window = getWindowDescription(group.orderingSchedule, now);
    const appUrl = await miniAppLink();
    const closeLabel = closePhrase(window);
    const privateText = buildPrivateText({ closeLabel, appUrl });
    const groupText = buildGroupText({
      groupName: group.name,
      deliveryLabel: deliveryDateLabel(group.dayOfWeek, group.orderingSchedule, now),
      closeLabel,
      appUrl,
    });

    let deliveredAny = false;

    for (const seller of sellers) {
      try {
        await sendMessageWithRetry(seller.telegramId, privateText);
        sentPrivate += 1;
        deliveredAny = true;
      } catch (err) {
      }
      await sleep(SEND_GAP_MS);
    }

    if (chatIds === null) chatIds = await serviceGroupChatIds();
    for (const chatId of chatIds) {
      try {
        await sendMessageWithRetry(chatId, groupText);
        sentGroups += 1;
        deliveredAny = true;
      } catch (err) {
      }
    }

    if (deliveredAny) {
      notifiedGroups += 1;
    } else {
      await releaseSession(sessionId);
    }
  }

  if (notifiedGroups) {
  }
  return { notifiedGroups, sentPrivate, sentGroups };
}

module.exports = {
  MAX_LATENESS_MS,
  SEND_GAP_MS,
  isFreshOpen,
  buildGroupText,
  buildPrivateText,
  deliveryDateLabel,
  closePhrase,
  notifyOrderingOpen,
};
