'use strict';

const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const OrderingSession = require('../models/OrderingSession');
const { isOrderingOpen, getNextOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { deriveSessionPhase } = require('../utils/sessionVocab');
const { ACTIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES, summarizeSessionRows } = require('../utils/sessionSummaryMath');

const UPCOMING_PREFLIGHT_MS = 24 * 60 * 60 * 1000;

function isUpcomingPreflightWindow(nextOrderingOpenAt, now = new Date()) {
  const nextMs = new Date(nextOrderingOpenAt || '').getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nextMs) || !Number.isFinite(nowMs)) return false;
  const diff = nextMs - nowMs;
  return diff > 0 && diff <= UPCOMING_PREFLIGHT_MS;
}

function isUpcomingPreflightTerminalPhase(phase) {
  return phase === 'completed' || phase === 'idle';
}

function deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now = new Date() }) {
  if (isUpcomingPreflightTerminalPhase(phase)
      && isUpcomingPreflightWindow(nextOrderingOpenAt, now)) {
    return 'upcoming_preflight';
  }
  return phase || 'idle';
}

async function loadSessionSummaryStats(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return summarizeSessionRows();

  const [tasks, orders] = await Promise.all([
    PickingTask.find(
      { orderingSessionId: sid },
      'status completionReason archiveReconciled productId',
    ).lean(),
    Order.find(
      { orderingSessionId: sid },
      'status',
    ).lean(),
  ]);

  // Legacy fallback: sessions completed before archiveReconciled was reliably
  // stamped can still prove archival from the Product document itself. New OOS
  // flows should normally be counted by archiveReconciled=true, which remains
  // historical even if the product is restored later.
  const unresolvedProductIds = [...new Set(tasks
    .filter((t) => t?.status === 'completed'
      && t?.completionReason === 'out_of_stock'
      && t?.archiveReconciled !== true
      && t?.productId)
    .map((t) => t.productId))];
  const archivedProducts = unresolvedProductIds.length
    ? await Product.find({ _id: { $in: unresolvedProductIds }, status: 'archived' }, '_id').lean()
    : [];

  return summarizeSessionRows({
    tasks,
    orders,
    archivedProductIds: archivedProducts.map((p) => p._id),
  });
}

/**
 * One canonical phase computation used by /picking and /delivery-groups.
 * This prevents the page header and the group selector from deriving two
 * different labels for the same OrderingSession.
 */
async function computeSessionPhase({ deliveryGroupId, sessionId, pickingStatus, orderingSchedule }) {
  const windowOpen = isOrderingOpen(orderingSchedule).isOpen;
  let hasWork = false;

  if (sessionId) {
    if (pickingStatus === 'completed') {
      // Completed task rows have bounded retention. Prefer the frozen session
      // summary so an old non-empty cycle remains `completed` even after its
      // detailed PickingTasks are purged. Empty completed cycles intentionally
      // remain `idle` (finalSummary.totalProductCount === 0).
      const sessionSummary = await OrderingSession.findById(
        sessionId,
        'finalSummary.finalizedAt finalSummary.totalProductCount',
      ).lean();
      if (sessionSummary?.finalSummary?.finalizedAt) {
        hasWork = Number(sessionSummary.finalSummary.totalProductCount || 0) > 0;
      } else {
        hasWork = (await PickingTask.countDocuments({
          orderingSessionId: String(sessionId),
          status: 'completed',
        })) > 0;
      }
    } else {
      hasWork = !!(await Order.exists({
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ACTIVE_ORDER_STATUSES },
        orderingSessionId: String(sessionId),
      }));
    }
  }

  return deriveSessionPhase({ pickingStatus: pickingStatus || 'pending', windowOpen, hasWork });
}

/**
 * Summary shown under the picking-session chip.
 * completed -> current completed session
 * idle      -> latest previous completed numbered session
 * live      -> null (live queue counters already cover it)
 */
async function buildSessionSummary(phase, { deliveryGroupId, sessionId, session }) {
  let target = null;
  let current = false;

  if (phase === 'completed' && sessionId) {
    target = session || await OrderingSession.findById(sessionId, 'seq openDate finalSummary pickingStatus').lean();
    current = true;
  } else if (phase === 'idle') {
    target = await OrderingSession.findOne(
      {
        groupId: String(deliveryGroupId),
        pickingStatus: 'completed',
        seq: { $ne: null },
        ...(sessionId ? { _id: { $ne: sessionId } } : {}),
      },
      'seq openDate finalSummary pickingStatus',
    ).sort({ openDate: -1 }).lean();
  }

  if (!target) return null;
  const targetId = String(target._id || sessionId);
  const frozen = target.finalSummary?.finalizedAt ? target.finalSummary : null;
  const stats = frozen || await loadSessionSummaryStats(targetId);

  // Lazy repair for sessions completed before finalSummary existed (or when the
  // original best-effort snapshot transiently failed). Safe/idempotent and only
  // runs while historical task rows are still present.
  if (!frozen && target.pickingStatus === 'completed') {
    OrderingSession.updateOne(
      { _id: targetId, pickingStatus: 'completed', 'finalSummary.finalizedAt': null },
      { $set: { finalSummary: { ...stats, finalizedAt: new Date() } } },
    ).catch((err) => {});
  }

  return {
    current,
    seq: target.seq ?? null,
    openDate: target.openDate ?? null,
    processedProductCount: Number(stats.processedProductCount || 0),
    totalProductCount: Number(stats.totalProductCount || 0),
    archivedProductCount: Number(stats.archivedProductCount || 0),
    archiveRequiredProductCount: Number(stats.archiveRequiredProductCount || 0),
    completedOrderCount: Number(stats.completedOrderCount || 0),
    totalOrderCount: Number(stats.totalOrderCount || 0),
  };
}

/**
 * Lightweight current-group presentation for the group selector. Read-only:
 * never materialises a session. `findCurrentSessionId` returns null when the
 * cycle has no document yet.
 */
async function getCurrentGroupPresentation(group, { now = new Date() } = {}) {
  const groupId = String(group?._id || '');
  const nextOrderingOpenAt = group?.orderingSchedule
    ? getNextOrderingWindowOpenAt(group.orderingSchedule, now).toISOString()
    : null;

  if (!groupId) {
    const phase = 'idle';
    return {
      pickingStatus: null,
      phase,
      presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
      nextOrderingOpenAt,
    };
  }

  const sessionId = await findCurrentSessionId(groupId, group.orderingSchedule);
  if (!sessionId) {
    const phase = deriveSessionPhase({
      pickingStatus: 'pending',
      windowOpen: isOrderingOpen(group.orderingSchedule, now).isOpen,
      hasWork: false,
    });
    return {
      pickingStatus: null,
      phase,
      presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
      nextOrderingOpenAt,
    };
  }

  const session = await OrderingSession.findById(sessionId, 'pickingStatus').lean();
  if (!session) {
    const phase = 'idle';
    return {
      pickingStatus: null,
      phase,
      presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
      nextOrderingOpenAt,
    };
  }
  const pickingStatus = session.pickingStatus || 'pending';
  const phase = await computeSessionPhase({
    deliveryGroupId: groupId,
    sessionId,
    pickingStatus,
    orderingSchedule: group.orderingSchedule,
  });
  return {
    pickingStatus,
    phase,
    presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
    nextOrderingOpenAt,
  };
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  summarizeSessionRows,
  loadSessionSummaryStats,
  computeSessionPhase,
  buildSessionSummary,
  getCurrentGroupPresentation,
  UPCOMING_PREFLIGHT_MS,
  isUpcomingPreflightWindow,
  isUpcomingPreflightTerminalPhase,
  deriveSessionPresentationMode,
};
