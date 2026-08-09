'use strict';

// Вибір групи: docs/receipt/readme.md#2-проведення-накладної-дозамовлення

const DeliveryGroup   = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order           = require('../models/Order');
const Shop            = require('../models/Shop');

const mongoose = require('mongoose');

const {
  isOrderingOpen,
  getWarsawNow,
  getOpenDateWarsaw,
  getNextOrderingWindowOpenAt,
  getOrderingWindowCloseAt,
  getPreviousOrderingCloseAt,
  DAY_FULL_UK,
} = require('../utils/orderingSchedule');
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

/** Людський формат приблизної тривалості. */
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

/** Час у часовому поясі Europe/Warsaw. */
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

/** Інформаційний опис групи; статус не блокує вибір. */
async function describeGroup(group, now) {
  const dayOfWeek = group.dayOfWeek;
  const schedule = group.orderingSchedule;
  const openDate = getOpenDateWarsaw(schedule, now);
  const session = await OrderingSession.findOne(
    { groupId: String(group._id), openDate },
    '_id pickingStatus',
  ).lean();

  const windowOpen = isOrderingOpen(schedule, now).isOpen;
  const todayIsDeliveryDay = getWarsawNow(now).dayOfWeek === dayOfWeek;

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
  base.shopCount = shopCount;
  // Навіть група без активних магазинів лишається клікабельною: статус тут
  // інформаційний, а остаточне рішення завжди приймає працівник.
  if (!shopCount) {
    base.note = 'У групі зараз немає активних магазинів. Дозамовлення відкриється, але продавців для приватного сповіщення може не бути.';
  }

  // ── Вікно ще відкрите ──────────────────────────────────────────────────────
  if (windowOpen) {
    const closeAt = getOrderingWindowCloseAt(schedule, now);
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
    const closedAt = getPreviousOrderingCloseAt(schedule, now);
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
  const nextOpenAt = getNextOrderingWindowOpenAt(schedule, now);
  const untilOpen = humanDuration(nextOpenAt.getTime() - now.getTime());

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

/** Усі групи з інформаційним станом. */
async function describeSupplementTargets(now = new Date()) {
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule').sort({ dayOfWeek: 1, name: 1 }).lean();

  const described = [];
  for (const group of groups) {
    if (!Number.isInteger(group.dayOfWeek)) continue;
    described.push(await describeGroup(group, now));
  }

  // Жодного поділу на «доступні/недоступні»: усі коректні групи клікабельні,
  // а статуси потрібні тільки як підказка.
  return {
    groups: described.map((g) => ({ ...g, selectable: true })),
    serverTime: now.toISOString(),
  };
}

/** Перевіряє лише коректність і існування вручну вибраної групи. */
async function resolveSupplementTarget(deliveryGroupId) {
  const gid = String(deliveryGroupId || '').trim();
  if (!gid || !mongoose.Types.ObjectId.isValid(gid)) throw appError('supplement_target_required');

  const group = await DeliveryGroup.findById(gid, 'name dayOfWeek orderingSchedule').lean();
  if (!group) throw appError('supplement_target_not_found');

  // Ні сесія, ні вікно замовлень, ні кількість магазинів не блокують вибір.
  return { deliveryGroupId: gid };
}

module.exports = {
  describeSupplementTargets,
  resolveSupplementTarget,
  humanDuration,
};
