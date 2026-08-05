'use strict';

/**
 * «Кому відкрити дозамовлення» — стан кожної групи доставки на момент проведення
 * накладної типу 'supplement'.
 *
 * Раніше цільові групи вгадувалися автоматично (resolveTargetSessions): вікно
 * закрите + сесія існує + у ній є живі замовлення + вона не завершена. Дві
 * останні умови були непрямими ознаками того, що людина й так знає, і кожна
 * давала збій у свій бік:
 *   • хибно-позитивний — накладна, проведена через день після доставки, відкривала
 *     дозамовлення групі, чиї коробки вже поїхали (сесія просто не була закрита);
 *   • хибно-негативний — коли склад устигав зібрати ВСІ замовлення, живих не
 *     лишалось, і пропозиція тихо не створювалась.
 * Тепер групу обирає людина, а цей модуль лише чесно показує стан кожної та
 * забороняє явно безглузді варіанти.
 *
 * ПРАВИЛО ДОПУСКУ (рішення власника 05.08.2026) тримається на одному спостереженні:
 * дозамовлення має сенс лише для доставки, яка ЩЕ НЕ ПОЇХАЛА. Оскільки вікно
 * замовлень закривається вранці ДНЯ доставки, це зводиться до:
 *
 *   вікно відкрите          → можна (з поясненням: магазини й так замовляють)
 *   вікно закрите, доставка СЬОГОДНІ → можна (головний сценарій)
 *   усе інше                → не можна
 *
 * «Усе інше» — це і завершена сесія, і день доставки, що вже минув (збирання у
 * цьому проєкті дозволене весь тиждень, тому жива сесія сама по собі нічого не
 * доводить), і група, чиє вікно лише відкриється — такий товар доїде до неї
 * звичайним шляхом, коли склад покладе його на полицю.
 */

const DeliveryGroup   = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order           = require('../models/Order');
const Shop            = require('../models/Shop');

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
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
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

/**
 * Стани, у яких групу МОЖНА обрати ціллю хвилі.
 *   'closed_today'  — вікно закрите, доставка сьогодні: власне дозамовлення;
 *   'ordering_open' — вікно ще відкрите: дозволено, але з поясненням, бо
 *                     магазини й так можуть замовити цей товар звичайним шляхом
 *                     (щойно склад покладе його на полицю).
 */
const ELIGIBLE_STATES = new Set(['closed_today', 'ordering_open']);

/** Чи ця група приймає дозамовлення просто зараз (єдине джерело правила). */
function isEligibleState(state) {
  return ELIGIBLE_STATES.has(state);
}

async function describeGroup(group, schedule, now) {
  const dayOfWeek = group.dayOfWeek;
  const openDate = getOpenDateWarsaw(dayOfWeek, schedule);
  // findOne, НЕ upsert: читання списку не має створювати сесії. Сесія
  // народжується лише в момент проведення, для групи, яку реально обрали.
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
    orderingSessionId: session ? String(session._id) : null,
  };

  // Порожня група — окремий випадок, який інакше виглядав би як звичайна
  // доступна ціль: хвиля відкрилась би, повідомлення не пішло б нікому, а
  // віртуальний блок висів би в складу, поки хтось не здогадається.
  const shopCount = await Shop.countDocuments({
    deliveryGroupId: String(group._id),
    isActive: true,
  });
  if (!shopCount) {
    return {
      ...base,
      state: 'no_shops',
      eligible: false,
      title: 'У групі немає активних магазинів',
      details: ['Дозамовлення нікому показувати'],
    };
  }

  // ── Вікно ще відкрите ──────────────────────────────────────────────────────
  if (windowOpen) {
    const closeAt = getOrderingWindowCloseAt(dayOfWeek, schedule);
    return {
      ...base,
      state: 'ordering_open',
      eligible: true,
      // Клієнт має спитати підтвердження: це законний, але нетиповий вибір.
      needsConfirm: true,
      title: 'Замовлення активні',
      details: [`Закриються через ${humanDuration(closeAt.getTime() - now.getTime())}`],
      confirmNote: 'Магазини цієї групи зараз і так можуть замовляти. Товари з накладної '
        + 'будуть додатково показані окремою секцією «Дозамовлення» та у віртуальному блоці складу.',
    };
  }

  // ── Вікно закрите, доставка СЬОГОДНІ — головний сценарій ───────────────────
  if (todayIsDeliveryDay) {
    if (session?.pickingStatus === 'completed') {
      return {
        ...base,
        state: 'session_completed',
        eligible: false,
        title: 'Поточна доставка завершена',
        details: ['Коробки закриті — дозамовлення відкриє роботу, якої ніхто не побачить'],
      };
    }

    const closedAt = getPreviousOrderingCloseAt(dayOfWeek, schedule);
    const details = [`Замовлення закрилися ${humanDuration(now.getTime() - closedAt.getTime())} тому`];

    details.push(session?.pickingStatus === 'in_progress'
      ? 'Збирання: триває'
      : 'Збирання ще не почалося');

    if (session) {
      const shopIds = await Order.distinct('buyerSnapshot.shopId', {
        orderingSessionId: String(session._id),
        'buyerSnapshot.deliveryGroupId': String(group._id),
        status: { $nin: ['cancelled', 'expired'] },
      });
      const withOrders = shopIds.filter(Boolean).length;
      details.push(`Магазинів із замовленнями: ${withOrders}`);
    } else {
      details.push('Магазинів із замовленнями: 0');
    }

    return { ...base, state: 'closed_today', eligible: true, title: 'Доставка сьогодні', details };
  }

  // ── Усе інше: доставка вже поїхала або ще далеко ───────────────────────────
  const openAt = getOrderingWindowOpenAt(dayOfWeek, schedule);
  const nextOpenAt = new Date(openAt.getTime() + 7 * DAY);
  const untilOpen = humanDuration(nextOpenAt.getTime() - now.getTime());

  // Жива незавершена сесія після дня доставки — не привід відкривати хвилю.
  // Збирання тут дозволене весь тиждень, тому такий стан цілком нормальний:
  // просто ця доставка вже поїхала, і докладати в неї нема куди.
  if (session && session.pickingStatus !== 'completed') {
    return {
      ...base,
      state: 'delivery_passed',
      eligible: false,
      title: `Доставка була в ${DAY_FULL_UK[dayOfWeek]} — збирання ще не закрите`,
      details: [
        'Докласти товар у вже відвантажену доставку не можна',
        `Наступне вікно замовлень — через ${untilOpen}`,
      ],
    };
  }

  return {
    ...base,
    state: 'window_not_open',
    eligible: false,
    title: `Замовлення відкриються через ${untilOpen}`,
    details: ['Товар буде доступний цій групі як звичайний — після розміщення на полиці'],
  };
}

// ─── Публічне API ────────────────────────────────────────────────────────────

/**
 * Усі групи зі станом + параметри майбутньої хвилі.
 * Недоступні групи теж повертаються — людина має бачити повну картину і
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

  // Доступні — вгору, решта нижче в природному порядку днів.
  described.sort((a, b) => Number(b.eligible) - Number(a.eligible));

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
 * Викликається В МОМЕНТ проведення, а не при показі списку: між відкриттям
 * модалки і натисканням кнопки могло минути пів години — за цей час вікно
 * замовлень могло закритися, сесію могли завершити, а день доставки — змінитися.
 *
 * Сесію тут уже СТВОРЮЄМО (getOrCreateSessionId): групу обрали свідомо, отже
 * робота для неї справді з'явиться.
 *
 * @throws {AppError} supplement_target_required | supplement_target_not_found |
 *                    supplement_target_not_eligible
 * @returns {Promise<{deliveryGroupId: string, orderingSessionId: string, state: string}>}
 */
async function resolveSupplementTarget(deliveryGroupId, now = new Date()) {
  const gid = String(deliveryGroupId || '').trim();
  if (!gid) throw appError('supplement_target_required');

  const group = await DeliveryGroup.findById(gid, 'name dayOfWeek').lean();
  if (!group || !Number.isInteger(group.dayOfWeek)) throw appError('supplement_target_not_found');

  const schedule = await getOrderingSchedule();
  const described = await describeGroup(group, schedule, now);
  if (!isEligibleState(described.state)) {
    throw appError('supplement_target_not_eligible', {
      group: group.name || '',
      reason: described.title,
    });
  }

  const orderingSessionId = await getOrCreateSessionId(gid, group.dayOfWeek, schedule);
  return { deliveryGroupId: gid, orderingSessionId, state: described.state };
}

module.exports = {
  describeSupplementTargets,
  resolveSupplementTarget,
  isEligibleState,
  humanDuration,
  ELIGIBLE_STATES,
};
