'use strict';

const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const OrderingSession = require('../models/OrderingSession');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { deriveSessionPhase } = require('../utils/sessionVocab');
const { ACTIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES, summarizeSessionRows } = require('../utils/sessionSummaryMath');

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
      hasWork = (await PickingTask.countDocuments({
        orderingSessionId: String(sessionId),
        status: 'completed',
      })) > 0;
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
    target = session || await OrderingSession.findById(sessionId, 'seq openDate').lean();
    current = true;
  } else if (phase === 'idle') {
    target = await OrderingSession.findOne(
      {
        groupId: String(deliveryGroupId),
        pickingStatus: 'completed',
        seq: { $ne: null },
        ...(sessionId ? { _id: { $ne: sessionId } } : {}),
      },
      'seq openDate',
    ).sort({ openDate: -1 }).lean();
  }

  if (!target) return null;
  const stats = await loadSessionSummaryStats(String(target._id || sessionId));
  return {
    current,
    seq: target.seq ?? null,
    openDate: target.openDate ?? null,
    ...stats,
  };
}

/**
 * Lightweight current-group presentation for the group selector. Read-only:
 * never materialises a session. `findCurrentSessionId` returns null when the
 * cycle has no document yet.
 */
async function getCurrentGroupPresentation(group) {
  const groupId = String(group?._id || '');
  if (!groupId) return { pickingStatus: null, phase: 'idle' };

  const sessionId = await findCurrentSessionId(groupId, group.orderingSchedule);
  if (!sessionId) {
    return {
      pickingStatus: null,
      phase: deriveSessionPhase({
        pickingStatus: 'pending',
        windowOpen: isOrderingOpen(group.orderingSchedule).isOpen,
        hasWork: false,
      }),
    };
  }

  const session = await OrderingSession.findById(sessionId, 'pickingStatus').lean();
  if (!session) return { pickingStatus: null, phase: 'idle' };
  const pickingStatus = session.pickingStatus || 'pending';
  const phase = await computeSessionPhase({
    deliveryGroupId: groupId,
    sessionId,
    pickingStatus,
    orderingSchedule: group.orderingSchedule,
  });
  return { pickingStatus, phase };
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  summarizeSessionRows,
  loadSessionSummaryStats,
  computeSessionPhase,
  buildSessionSummary,
  getCurrentGroupPresentation,
};
