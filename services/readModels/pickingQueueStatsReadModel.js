'use strict';

const DeliveryGroup = require('../../models/DeliveryGroup');
const OrderingSession = require('../../models/OrderingSession');
const PickingTask = require('../../models/PickingTask');
const Order = require('../../models/Order');
const { findCurrentSessionId } = require('../../utils/getOrCreateSession');
const {
  isOrderingOpen,
  getOrderingWindowCloseAt,
  getNextOrderingWindowOpenAt,
  getPickingReadiness,
} = require('../../utils/orderingSchedule');
const {
  ACTIVE_ORDER_STATUSES,
  computeSessionPhase,
  buildSessionSummary,
  deriveSessionPresentationMode,
} = require('../sessionPresentation');
const { countActiveOffersForGroup } = require('../supplementOffers');

function emptyTaskStats() {
  return {
    pendingCount: 0,
    lockedByMeCount: 0,
    lockedByOtherCount: 0,
  };
}

async function loadTaskStats({ deliveryGroupId, orderingSessionId, telegramId }) {
  if (!orderingSessionId) return emptyTaskStats();

  const [row] = await PickingTask.aggregate([
    {
      $match: {
        deliveryGroupId: String(deliveryGroupId),
        orderingSessionId: String(orderingSessionId),
        status: { $in: ['pending', 'locked'] },
      },
    },
    {
      $group: {
        _id: null,
        pendingCount: {
          $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
        },
        lockedByMeCount: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$status', 'locked'] }, { $eq: ['$lockedBy', String(telegramId)] }] },
              1,
              0,
            ],
          },
        },
        lockedByOtherCount: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$status', 'locked'] }, { $ne: ['$lockedBy', String(telegramId)] }] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $project: { _id: 0 } },
  ]);

  return {
    ...emptyTaskStats(),
    ...(row || {}),
  };
}

async function loadOrderWorkStats({ deliveryGroupId, orderingSessionId }) {
  if (!orderingSessionId) return { activeOrderExists: false, orderedPositions: 0 };

  try {
    const [row] = await Order.aggregate([
    {
      $match: {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ACTIVE_ORDER_STATUSES },
        orderingSessionId: String(orderingSessionId),
      },
    },
    {
      $facet: {
        activeOrders: [{ $limit: 1 }, { $count: 'count' }],
        orderedPositions: [
          { $unwind: '$items' },
          {
            $match: {
              'items.productId': { $exists: true, $nin: [null, ''] },
              'items.packed': { $ne: true },
              'items.cancelled': { $ne: true },
              'items.skipped': { $ne: true },
              'items.voided': { $ne: true },
            },
          },
          { $group: { _id: '$items.productId' } },
          { $count: 'count' },
        ],
      },
    },
    ]);

    return {
      activeOrderExists: Number(row?.activeOrders?.[0]?.count || 0) > 0,
      orderedPositions: Number(row?.orderedPositions?.[0]?.count || 0),
    };
  } catch (err) {
    // orderedPositions has always been best-effort. `null` keeps phase logic
    // authoritative: computeSessionPhase will fall back to its own Order.exists.
    return { activeOrderExists: null, orderedPositions: 0 };
  }
}

async function buildPickingQueueStatsReadModel({ deliveryGroupId, telegramId, now = new Date() }) {
  const groupId = String(deliveryGroupId || '');
  const workerId = String(telegramId || '');

  const group = groupId
    ? await DeliveryGroup.findById(groupId, 'dayOfWeek name orderingSchedule').lean()
    : null;
  const currentSessionId = group
    ? await findCurrentSessionId(groupId, group.orderingSchedule)
    : null;

  const [taskStats, orderStats, supplementCount] = await Promise.all([
    loadTaskStats({ deliveryGroupId: groupId, orderingSessionId: currentSessionId, telegramId: workerId }),
    loadOrderWorkStats({ deliveryGroupId: groupId, orderingSessionId: currentSessionId }),
    countActiveOffersForGroup(groupId, { orderingSessionId: currentSessionId }),
  ]);

  const pendingCount = Number(taskStats.pendingCount || 0);
  const lockedByMeCount = Number(taskStats.lockedByMeCount || 0);
  const lockedByOtherCount = Number(taskStats.lockedByOtherCount || 0);
  const activeCount = pendingCount + lockedByMeCount + lockedByOtherCount;

  let pickingStatus = null;
  let events = [];
  let phase = null;
  let sessionSummary = null;
  let groupDayOfWeek = null;
  let presentationMode = null;
  let nextOrderingOpenAt = null;
  let windowOpen = false;
  let windowCloseAt = null;
  let windowMessage = '';
  let serverNow = now.toISOString();
  let pickingReadyAt = null;
  let pickingReady = false;
  let pickingReadyInMs = null;

  if (group) {
    groupDayOfWeek = group.dayOfWeek;
    const windowState = isOrderingOpen(group.orderingSchedule, now);
    const readiness = getPickingReadiness(group.orderingSchedule, now);
    serverNow = readiness.serverNow.toISOString();
    pickingReadyAt = readiness.pickingReadyAt.toISOString();
    pickingReady = readiness.pickingReady;
    pickingReadyInMs = readiness.pickingReadyInMs;
    windowOpen = Boolean(windowState.isOpen);
    windowMessage = windowState.message || '';
    windowCloseAt = windowOpen
      ? getOrderingWindowCloseAt(group.orderingSchedule, now).toISOString()
      : null;
    nextOrderingOpenAt = getNextOrderingWindowOpenAt(group.orderingSchedule, now).toISOString();

    try {
      const sessionDoc = currentSessionId
        ? await OrderingSession.findById(
            currentSessionId,
            'pickingStatus events seq openDate finalSummary',
          ).lean()
        : null;

      if (sessionDoc) {
        pickingStatus = sessionDoc.pickingStatus || 'pending';
        events = (sessionDoc.events || []).slice(-10);
        phase = await computeSessionPhase({
          deliveryGroupId: groupId,
          sessionId: currentSessionId,
          pickingStatus,
          orderingSchedule: group.orderingSchedule,
          session: sessionDoc,
          activeOrderExists: orderStats.activeOrderExists,
        });
        sessionSummary = await buildSessionSummary(phase, {
          deliveryGroupId: groupId,
          sessionId: currentSessionId,
          session: sessionDoc,
        });
      } else {
        phase = windowOpen ? 'ordering_open' : 'idle';
      }

      presentationMode = deriveSessionPresentationMode({
        phase,
        nextOrderingOpenAt,
        now,
      });
    } catch (err) {
      // Preserve the old endpoint contract: live queue counters remain usable
      // even when presentation/history enrichment has a transient read failure.
    }
  }

  return {
    pendingCount,
    lockedByMeCount,
    lockedByOtherCount,
    activeCount,
    orderingSessionId: currentSessionId ? String(currentSessionId) : null,
    orderedPositions: Number(orderStats.orderedPositions || 0),
    pickingStatus,
    events,
    phase,
    sessionSummary,
    groupDayOfWeek,
    presentationMode,
    nextOrderingOpenAt,
    windowOpen,
    windowCloseAt,
    windowMessage,
    serverNow,
    pickingReadyAt,
    pickingReady,
    pickingReadyInMs,
    supplementCount: Number(supplementCount || 0),
  };
}

module.exports = {
  buildPickingQueueStatsReadModel,
  loadTaskStats,
  loadOrderWorkStats,
};
