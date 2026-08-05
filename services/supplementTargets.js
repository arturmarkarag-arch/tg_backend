'use strict';

/**
 * «Кому відкрити дозамовлення» — стан кожної групи доставки на момент проведення
 * накладної типу 'supplement'.
 *
 * ІСТОРІЯ РІШЕННЯ (важлива, щоб ніхто не «повернув як було»):
 *
 * 1. Спочатку цільові групи вгадувалися автоматично (resolveTargetSessions):
 *    вікно закрите + сесія існує + у ній є живі замовлення. Обидві останні умови
 *    були непрямими ознаками того, що людина й так знає, і кожна давала збій у
 *    свій бік — накладна через день після доставки відкривала хвилю групі, чиї
 *    коробки вже поїхали; а коли склад устигав зібрати ВСЕ, пропозиція тихо не
 *    створювалась.
 *
 * 2. Потім групу почала обирати людина, але сервер лишив за собою право допуску
 *    (eligible): «вікно відкрите або доставка сьогодні — можна, решта — ні».
 *    Правило виглядало розумним і все одно заважало: воно вирішувало за людину в
 *    ситуаціях, які людина бачить краще за будь-яку евристику.
 *
 * 3. ТЕПЕР (рішення власника 05.08.2026, друга ітерація): сервер НЕ вирішує
 *    нічого, крім фізично неможливого. Усі групи клікабельні, статус — виключно
 *    підказка для працівника, остаточне рішення завжди його.
 *
 * Серверна перевірка звелася до трьох речей:
 *   • переданий deliveryGroupId коректний;
 *   • група існує (і має день тижня, інакше розклад для неї не рахується);
 *   • у групі є хоч один активний магазин.
 *
 * Стан звичайного вікна замовлень НЕ Є причиною для відмови. Так само НЕ Є
 * причиною завершена доставка, ненастале вікно чи відсутність сесії збирання:
 * хвиля дозамовлення прив'язується ЛИШЕ до групи (див. models/SupplementOffer.js)
 * і живе власним циклом open → frozen → completed.
 *
 * `no_shops` — єдиний стан, у якому вибір заблокований. Не «щоб не пустити», а
 * тому що показувати хвилю нікому: повідомлення не пішло б жодному продавцю, а
 * віртуальний блок висів би в складу, поки хтось не здогадається.
 */

const DeliveryGroup   = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order           = require('../models/Order');
const Shop            = require('../models/Shop');

const mongoose = require('mongoose');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const {
  isOrderingOpen,
  getWarsawNow,
  getOpenDateWarsaw,
  getOrderingWindowOpenAt,
  getOrderingWindowCloseAt,
  getPreviousOrderingCloseAt,
  DAY_FULL_UK,
} = require('../utils/orderingSchedule');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { appError } = require('../utils/errors');

// ─── Формат тривалості ───────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

function plural(n, one, few, many) {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * «3 години», «45 хвилин», «2 дні» — так, як це вимовляє людина.
 * Округлення свідомо грубе: різниця між 3:07 і 3:12 нікого не цікавить, а
 * точний момент закриття все одно показується окремим рядком.
 */
function humanDuration(ms) {
  const abs = Math.max(0, ms);
  if (abs < MINUTE) return 'менше хвилини';
  if (abs < HOUR) {
    const m = Math.round(abs / MINUTE);
    return `${m} ${plural(m, 'хвилину', 'хвилини', 'хвилин')}`;
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs % HOUR) / MINUTE);
    const head = `${h} ${plural(h, 'годину', 'години', 'годин')}`;
    if (!m) return head;
    return `${head} ${m} ${plural(m, 'хвилину', 'хвилини', 'хвилин')}`;
  }
  const d = Math.round(abs / DAY);
  return `${d} ${plural(d, 'день', 'дні', 'днів')}`;
}

/** Warsaw HH:MM — той самий формат, що й у повідомленнях бота. */
function fmtTime(date) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date));
}

// ─── Стан однієї групи ───────────────────────────────────────────────────────

/** Стан збирання людською мовою. Немає сесії — збирання ще не починалося. */
function pickingHint(session) {
  if (!session) return 'Збирання ще не почалося';
  if (session.pickingStatus === 'in_progress') return 'Збирання: триває';
  if (session.pickingStatus === 'completed') return 'Збирання: завершено — коробки, найімовірніше, вже закриті';
  return 'Збирання ще не почалося';
}

/**
 * Опис групи: що з нею відбувається ЗАРАЗ і чи можна її вибрати.
 *
 * `selectable` тут не «правило допуску», а відповідь на питання «чи є кому це
 * показати». Усе інше — рядки для очей працівника.
 *
 * Сесія читається через findOne, НЕ upsert: ні показ списку, ні саме проведення
 * накладної більше не створюють OrderingSession. Хвиля дозамовлення до сесії не
 * прив'язана, а створювати сесію майбутньої доставки як побічний ефект
 * приймання товару — рівно та плутанина, від якої ми відходимо.
 */
async function describeGroup(group, schedule, now) {
  const dayOfWeek = group.dayOfWeek;
  const openDate = getOpenDateWarsaw(dayOfWeek, schedule);
  const session = await OrderingSession.findOne(
    { groupId: String(group._id), openDate },
    '_id pickingStatus',
  ).lean();

  const windowOpen = isOrderingOpen(dayOfWeek, schedule).isOpen;
  const todayIsDeliveryDay = getWarsawNow().dayOfWeek === dayOfWeek;

  const base = {
    deliveryGroupId: String(group._id),
    name: group.name || '',
    dayOfWeek,
    dayName: DAY_FULL_UK[dayOfWeek] || '',
    pickingStatus: session?.pickingStatus || null,
  };

  const shopCount = await Shop.countDocuments({
    deliveryGroupId: String(group._id),
    isActive: true,
  });
  if (!shopCount) {
    return {
      ...base,
      state: 'no_shops',
      selectable: false,
      title: 'У групі немає активних магазинів',
      details: ['Дозамовлення нікому показувати'],
    };
  }

  base.shopCount = shopCount;

  // ── Вікно ще відкрите ──────────────────────────────────────────────────────
  if (windowOpen) {
    const closeAt = getOrderingWindowCloseAt(dayOfWeek, schedule);
    return {
      ...base,
      state: 'ordering_open',
      selectable: true,
      title: 'Замовлення активні',
      details: [`Закриються через ${humanDuration(closeAt.getTime() - now.getTime())}`],
      note: 'Магазини цієї групи зараз і так можуть замовляти. Товари з накладної '
        + 'будуть додатково показані окремою секцією «Дозамовлення» та у віртуальному блоці складу.',
    };
  }

  // ── Вікно закрите, доставка СЬОГОДНІ — головний сценарій ───────────────────
  if (todayIsDeliveryDay) {
    const closedAt = getPreviousOrderingCloseAt(dayOfWeek, schedule);
    const details = [
      `Замовлення закрилися ${humanDuration(now.getTime() - closedAt.getTime())} тому`,
      pickingHint(session),
    ];

    if (session) {
      const shopIds = await Order.distinct('buyerSnapshot.shopId', {
        orderingSessionId: String(session._id),
        'buyerSnapshot.deliveryGroupId': String(group._id),
        status: { $nin: ['cancelled', 'expired'] },
      });
      details.push(`Магазинів із замовленнями: ${shopIds.filter(Boolean).length}`);
    } else {
      details.push('Магазинів із замовленнями: 0');
    }

    return { ...base, state: 'closed_today', selectable: true, title: 'Доставка сьогодні', details };
  }

  // ── Вікно закрите, доставка не сьогодні ────────────────────────────────────
  // Наступне відкриття — на тиждень від поточного (розклад тижневий).
  const openAt = getOrderingWindowOpenAt(dayOfWeek, schedule);
  const untilOpen = humanDuration(openAt.getTime() + 7 * DAY - now.getTime());

  if (session) {
    const done = session.pickingStatus === 'completed';
    return {
      ...base,
      state: 'delivery_passed',
      selectable: true,
      title: done
        ? 'Попередня доставка завершена'
        : `Доставка була в ${DAY_FULL_UK[dayOfWeek] || 'цій групі'} — збирання ще не закрите`,
      details: [
        done ? 'Наступна сесія ще не почалася' : pickingHint(session),
        `Наступні замовлення відкриються через ${untilOpen}`,
      ],
    };
  }

  return {
    ...base,
    state: 'window_not_open',
    selectable: true,
    title: `Замовлення відкриються через ${untilOpen}`,
    details: [`Наступна доставка — ${DAY_FULL_UK[dayOfWeek] || '—'}`],
  };
}

// ─── Публічне API ────────────────────────────────────────────────────────────

/**
 * Усі групи зі станом + параметри майбутньої хвилі.
 * Групи без магазинів теж повертаються — людина має бачити повну картину і
 * розуміти, ЧОМУ саме тут вибрати не можна.
 */
async function describeSupplementTargets(now = new Date()) {
  const schedule = await getOrderingSchedule();
  const { windowMinutes } = await getSupplementSettings();
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek').sort({ dayOfWeek: 1, name: 1 }).lean();

  const described = [];
  for (const group of groups) {
    if (!Number.isInteger(group.dayOfWeek)) continue;
    described.push(await describeGroup(group, schedule, now));
  }

  // Групи без магазинів — у хвіст. Решта лишається в природному порядку днів:
  // сортувати за «доречністю» означало б знову вирішувати за людину.
  described.sort((a, b) => Number(b.selectable) - Number(a.selectable));

  const closesAt = new Date(now.getTime() + windowMinutes * MINUTE);
  return {
    groups: described,
    window: {
      minutes: windowMinutes,
      humanDuration: humanDuration(windowMinutes * MINUTE),
      // Орієнтовний час закриття: справжній рахується в момент проведення.
      closesAtPreview: closesAt,
      closesAtLabel: fmtTime(closesAt),
    },
    serverTime: now.toISOString(),
  };
}

/**
 * Перевірити вибір людини і зафіксувати ціль хвилі.
 *
 * Викликається В МОМЕНТ проведення, а не при показі списку — але перевіряє вже
 * тільки те, що не може змінити рішення працівника: група справді існує і в ній
 * справді є магазини. Час, вікно замовлень і стан збирання тут НЕ перевіряються
 * свідомо: між відкриттям модалки і натисканням кнопки вони могли змінитися, і
 * колишня відмова «група вже не підходить» була рівно тим, що ми прибрали.
 *
 * Свідомо НЕ використовує describeGroup: той читає розклад, сесію і замовлення,
 * щоб зібрати текст для очей, а тут потрібні лише три факти. Викликати його
 * заради валідації означало б платити Order.distinct за кожне проведення — і, що
 * гірше, тримати правило допуску «десь у тому описі», куди його легко повернути.
 *
 * @throws {AppError} supplement_target_required | supplement_target_not_found |
 *                    supplement_target_no_shops
 * @returns {Promise<{deliveryGroupId: string}>}
 */
async function resolveSupplementTarget(deliveryGroupId) {
  const gid = String(deliveryGroupId || '').trim();
  if (!gid || !mongoose.Types.ObjectId.isValid(gid)) throw appError('supplement_target_required');

  const group = await DeliveryGroup.findById(gid, 'name dayOfWeek').lean();
  // dayOfWeek потрібен не для допуску, а тому що без нього для групи неможливо
  // порахувати ні розклад, ні номери коробок — така група зламана.
  if (!group || !Number.isInteger(group.dayOfWeek)) throw appError('supplement_target_not_found');

  const shopCount = await Shop.countDocuments({ deliveryGroupId: gid, isActive: true });
  if (!shopCount) throw appError('supplement_target_no_shops', { group: group.name || '' });

  return { deliveryGroupId: gid };
}

module.exports = {
  describeSupplementTargets,
  resolveSupplementTarget,
  humanDuration,
};
