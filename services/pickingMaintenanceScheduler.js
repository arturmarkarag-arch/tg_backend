'use strict';

/**
 * Server-owned picking maintenance.
 *
 * Operational cleanup must not depend on a warehouse browser polling a GET
 * endpoint. This scheduler owns the two repairs that historically leaked into
 * reads: stale/duplicate lock cleanup and legacy completed-session summary
 * backfill. New lifecycle transitions still write their own finalSummary at the
 * moment of completion; the backfill exists only for old/interrupted rows.
 */

const OrderingSession = require('../models/OrderingSession');
const PickingTask = require('../models/PickingTask');
const Order = require('../models/Order');
const { releaseStalePickingLocks, repairDuplicateWorkerLocks } = require('./pickingService');
const { loadSessionSummaryStats } = require('./sessionPresentation');
const { runAsSchedulerLeader } = require('./schedulerLeader');

const TICK_MS = 30 * 1000;
const SUMMARY_REPAIR_LIMIT = 10;
let timer = null;
let running = false;

async function repairMissingFinalSummaries({ limit = SUMMARY_REPAIR_LIMIT } = {}) {
  const sessions = await OrderingSession.find(
    {
      pickingStatus: 'completed',
      'finalSummary.finalizedAt': null,
    },
    '_id pickingCompletedAt',
  ).sort({ pickingCompletedAt: -1, _id: -1 }).limit(limit).lean();

  let repaired = 0;
  for (const session of sessions) {
    const sid = String(session._id);
    // Do not invent a historical 0/0 summary after detailed retention has
    // already removed every proof row. Those very old rows stay readable via
    // their lifecycle status without a fabricated counter snapshot.
    const [hasTask, hasOrder] = await Promise.all([
      PickingTask.exists({ orderingSessionId: sid }),
      Order.exists({ orderingSessionId: sid }),
    ]);
    if (!hasTask && !hasOrder) continue;

    const summary = await loadSessionSummaryStats(sid);
    const finalizedAt = session.pickingCompletedAt || new Date();
    const result = await OrderingSession.updateOne(
      {
        _id: session._id,
        pickingStatus: 'completed',
        'finalSummary.finalizedAt': null,
      },
      { $set: { finalSummary: { ...summary, finalizedAt } } },
    );
    repaired += result.modifiedCount ?? result.nModified ?? 0;
  }
  return { repaired };
}

async function runPickingMaintenanceTick(now = new Date()) {
  const [staleResult, duplicateResult, summaryResult] = await Promise.all([
    releaseStalePickingLocks({ now }),
    repairDuplicateWorkerLocks(),
    repairMissingFinalSummaries(),
  ]);

  return {
    staleReleased: staleResult?.modifiedCount ?? staleResult?.nModified ?? 0,
    duplicateReleased: duplicateResult?.released || 0,
    summariesRepaired: summaryResult?.repaired || 0,
  };
}

function startPickingMaintenanceScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAsSchedulerLeader(
        'picking-maintenance',
        () => runPickingMaintenanceTick(),
        { ttlMs: 2 * 60 * 1000 },
      );
    } catch (err) {
      // Best-effort maintenance. The next tick retries; request paths keep their
      // explicit ownership/compare-and-swap guards and never depend on success.
    } finally {
      running = false;
    }
  };

  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}

function stopPickingMaintenanceScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  TICK_MS,
  SUMMARY_REPAIR_LIMIT,
  repairMissingFinalSummaries,
  runPickingMaintenanceTick,
  startPickingMaintenanceScheduler,
  stopPickingMaintenanceScheduler,
};
