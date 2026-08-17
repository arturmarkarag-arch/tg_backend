'use strict';

/**
 * V48.S2 canonical supplement target resolver.
 *
 * No "morning", "closed N minutes ago" or next-window heuristic may decide
 * eligibility. A target is one CURRENT delivery-cycle OrderingSession that has
 * already materialised and is not terminal. Staff choose explicitly; publish
 * revalidates the exact session server-side.
 */
const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Shop = require('../models/Shop');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { isOrderingOpen, DAY_FULL_UK } = require('../utils/orderingSchedule');
const { appError } = require('../utils/errors');

function str(v) { return v == null ? '' : String(v); }

function stateForSession(session, group, now = new Date()) {
  if (!session) return 'upcoming_not_started';
  if (session.openAt && new Date(session.openAt).getTime() > now.getTime()) return 'upcoming_not_started';
  if (session.pickingStatus === 'completed') return 'completed';
  if (session.pickingStatus === 'confirmed' || session.pickingStatus === 'in_progress') return 'picking';
  return isOrderingOpen(group.orderingSchedule, now).isOpen ? 'ordering_open' : 'awaiting_picking';
}

function titleForState(state) {
  if (state === 'ordering_open') return 'Поточна доставка · замовлення відкриті';
  if (state === 'awaiting_picking') return 'Поточна доставка · замовлення закриті';
  if (state === 'picking') return 'Поточна доставка · збирання';
  if (state === 'completed') return 'Доставка завершена';
  return 'Наступна сесія ще не почалася';
}

async function describeGroup(group, now = new Date()) {
  const groupId = str(group?._id);
  let sessionId = null;
  try { sessionId = await findCurrentSessionId(groupId, group.orderingSchedule); } catch (_) {}
  const session = sessionId
    ? await OrderingSession.findById(sessionId, '_id seq openDate openAt closeAt pickingStatus').lean()
    : null;

  const state = stateForSession(session, group, now);
  const shopCount = await Shop.countDocuments({ deliveryGroupId: groupId, isActive: true });
  const selectable = !!session
    && !['completed', 'upcoming_not_started'].includes(state)
    && shopCount > 0;

  return {
    deliveryGroupId: groupId,
    name: group.name || '',
    dayOfWeek: group.dayOfWeek,
    dayName: DAY_FULL_UK[group.dayOfWeek] || '',
    selectable,
    state,
    title: titleForState(state),
    orderingSessionId: session ? str(session._id) : null,
    sessionSeq: session?.seq ?? null,
    sessionOpenDate: session?.openDate || null,
    pickingStatus: session?.pickingStatus || null,
    orderingOpen: state === 'ordering_open',
    shopCount,
    details: session
      ? [
        `Сесія${session.seq != null ? ` №${session.seq}` : ''}: ${session.openDate || '—'}`,
        state === 'ordering_open'
          ? 'Звичайне замовлення ще відкрите'
          : state === 'awaiting_picking'
            ? 'Звичайне замовлення закрите, збирання ще не почалось'
            : state === 'picking'
              ? 'Збирання цієї доставки вже триває'
              : 'Сесія завершена',
      ]
      : ['Дозамовлення не потрібне: ця група отримає товар у своїй звичайній сесії'],
    note: selectable ? '' : (state === 'completed'
      ? 'Завершену доставку не можна повторно відкривати через дозамовлення.'
      : 'Майбутня сесія не є ціллю дозамовлення.'),
  };
}

async function describeSupplementTargets(now = new Date()) {
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule')
    .sort({ dayOfWeek: 1, name: 1 })
    .lean();
  const described = [];
  for (const group of groups) {
    if (!Number.isInteger(group.dayOfWeek) || !group.orderingSchedule) continue;
    described.push(await describeGroup(group, now));
  }
  return { groups: described, serverTime: now.toISOString() };
}

/**
 * Resolves and pins the CURRENT session. `expectedOrderingSessionId` protects the
 * confirmation screen from a cycle rollover between GET targets and POST publish.
 */
async function resolveSupplementTarget(
  deliveryGroupId,
  { expectedOrderingSessionId = null, now = new Date() } = {},
) {
  const gid = str(deliveryGroupId).trim();
  if (!gid || !mongoose.Types.ObjectId.isValid(gid)) throw appError('supplement_target_required');

  const group = await DeliveryGroup.findById(gid, 'name dayOfWeek orderingSchedule').lean();
  if (!group) throw appError('supplement_target_not_found');

  const sessionId = await findCurrentSessionId(gid, group.orderingSchedule);
  if (!sessionId) {
    throw appError('supplement_target_session_not_started', { group: group.name || '' });
  }
  if (expectedOrderingSessionId && str(expectedOrderingSessionId) !== str(sessionId)) {
    throw appError('supplement_target_session_changed', { group: group.name || '' });
  }

  const session = await OrderingSession.findById(
    sessionId,
    '_id groupId seq openDate openAt closeAt pickingStatus',
  ).lean();
  if (!session || str(session.groupId) !== gid) throw appError('supplement_target_session_not_started', { group: group.name || '' });
  if (session.pickingStatus === 'completed') throw appError('supplement_target_session_completed', { group: group.name || '' });

  // A future pre-created session is not eligible. Normal current sessions are
  // proactively materialised by orderingOpenScheduler at/after openAt.
  if (session.openAt && new Date(session.openAt).getTime() > now.getTime()) {
    throw appError('supplement_target_session_not_started', { group: group.name || '' });
  }

  const hasActiveShop = await Shop.exists({ deliveryGroupId: gid, isActive: true });
  if (!hasActiveShop) throw appError('supplement_target_no_shops', { group: group.name || '' });

  const state = stateForSession(session, group, now);
  return {
    deliveryGroupId: gid,
    orderingSessionId: str(session._id),
    sessionSeq: session.seq ?? null,
    sessionOpenDate: session.openDate || null,
    state,
    orderingOpen: state === 'ordering_open',
    groupName: group.name || '',
  };
}

module.exports = {
  describeSupplementTargets,
  resolveSupplementTarget,
  stateForSession,
};
