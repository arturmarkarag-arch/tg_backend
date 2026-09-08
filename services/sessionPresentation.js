'use strict';

const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const OrderingSession = require('../models/OrderingSession');
const { isOrderingOpen, getNextOrderingWindowOpenAt, getOpenDateWarsaw, normalizeOrderingSchedule } = require('../utils/orderingSchedule');
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
async function computeSessionPhase({
  deliveryGroupId,
  sessionId,
  pickingStatus,
  orderingSchedule,
  session = null,
  activeOrderExists = null,
}) {
  const windowOpen = isOrderingOpen(orderingSchedule).isOpen;
  let hasWork = false;

  if (sessionId) {
    if (pickingStatus === 'completed') {
      // Completed task rows have bounded retention. Prefer the frozen session
      // summary so an old non-empty cycle remains `completed` even after its
      // detailed PickingTasks are purged. Empty completed cycles intentionally
      // remain `idle` (finalSummary.totalProductCount === 0).
      const sessionSummary = session || await OrderingSession.findById(
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
    } else if (typeof activeOrderExists === 'boolean') {
      hasWork = activeOrderExists;
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

  // Presentation is deliberately read-only. Legacy/missed finalSummary repair
  // is owned by the server maintenance scheduler, never by a GET/page render.
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
 * Batch form of getCurrentGroupPresentation() for the delivery-group selector.
 * Session identity is still the canonical {groupId, openDate}; the only change
 * is query shape: one session read + bounded grouped work reads, independent of
 * the number of delivery groups.
 */
async function getCurrentGroupPresentations(groups, { now = new Date() } = {}) {
  const rows = Array.isArray(groups) ? groups : [];
  if (!rows.length) return [];

  const identities = rows.map((group) => {
    const groupId = String(group?._id || '');
    const schedule = normalizeOrderingSchedule(group?.orderingSchedule);
    return {
      group,
      groupId,
      schedule,
      openDate: groupId ? getOpenDateWarsaw(schedule) : null,
    };
  });

  const clauses = identities
    .filter((row) => row.groupId && row.openDate)
    .map((row) => ({ groupId: row.groupId, openDate: row.openDate }));

  const sessions = clauses.length
    ? await OrderingSession.find(
        { $or: clauses },
        'groupId openDate pickingStatus finalSummary',
      ).lean()
    : [];

  const sessionByIdentity = new Map(sessions.map((session) => [
    `${String(session.groupId)}|${String(session.openDate)}`,
    session,
  ]));

  const activeSessionIds = sessions
    .filter((session) => session.pickingStatus !== 'completed')
    .map((session) => String(session._id));
  const legacyCompletedSessionIds = sessions
    .filter((session) => session.pickingStatus === 'completed' && !session.finalSummary?.finalizedAt)
    .map((session) => String(session._id));

  const [activeOrderSessions, completedTaskSessions] = await Promise.all([
    activeSessionIds.length
      ? Order.aggregate([
          { $match: { orderingSessionId: { $in: activeSessionIds }, status: { $in: ACTIVE_ORDER_STATUSES } } },
          {
            $group: {
              _id: {
                orderingSessionId: '$orderingSessionId',
                deliveryGroupId: '$buyerSnapshot.deliveryGroupId',
              },
            },
          },
        ])
      : [],
    legacyCompletedSessionIds.length
      ? PickingTask.aggregate([
          { $match: { orderingSessionId: { $in: legacyCompletedSessionIds }, status: 'completed' } },
          { $group: { _id: '$orderingSessionId' } },
        ])
      : [],
  ]);

  const activeOrderSessionIds = new Set(activeOrderSessions.map((row) => (
    `${String(row?._id?.orderingSessionId || '')}|${String(row?._id?.deliveryGroupId || '')}`
  )));
  const completedTaskSessionIds = new Set(completedTaskSessions.map((row) => String(row._id || '')));

  return identities.map(({ group, groupId, schedule, openDate }) => {
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

    const session = sessionByIdentity.get(`${groupId}|${String(openDate)}`) || null;
    if (!session) {
      const phase = deriveSessionPhase({
        pickingStatus: 'pending',
        windowOpen: isOrderingOpen(schedule, now).isOpen,
        hasWork: false,
      });
      return {
        pickingStatus: null,
        phase,
        presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
        nextOrderingOpenAt,
      };
    }

    const pickingStatus = session.pickingStatus || 'pending';
    const sessionId = String(session._id);
    let hasWork = false;
    if (pickingStatus === 'completed') {
      hasWork = session.finalSummary?.finalizedAt
        ? Number(session.finalSummary.totalProductCount || 0) > 0
        : completedTaskSessionIds.has(sessionId);
    } else {
      hasWork = activeOrderSessionIds.has(`${sessionId}|${groupId}`);
    }
    const phase = deriveSessionPhase({
      pickingStatus,
      windowOpen: isOrderingOpen(schedule, now).isOpen,
      hasWork,
    });
    return {
      pickingStatus,
      phase,
      presentationMode: deriveSessionPresentationMode({ phase, nextOrderingOpenAt, now }),
      nextOrderingOpenAt,
    };
  });
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
  getCurrentGroupPresentations,
  UPCOMING_PREFLIGHT_MS,
  isUpcomingPreflightWindow,
  isUpcomingPreflightTerminalPhase,
  deriveSessionPresentationMode,
};
