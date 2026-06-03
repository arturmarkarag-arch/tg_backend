'use strict';

const PickingTask = require('../models/PickingTask');

// Completed picking tasks are deliberately KEPT after a session ends (so the
// session's "зібрано N" summary survives), but only the CURRENT session is ever
// counted on the board — tasks from sessions weeks in the past are pure dead
// weight. A TTL index can't express "status === 'completed' AND old" (TTL indexes
// cannot be partial), so this is swept on a schedule instead of by the engine.
const COMPLETED_PICKING_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

async function purgeOldCompletedPickingTasks(now = Date.now()) {
  const cutoff = new Date(now - COMPLETED_PICKING_RETENTION_DAYS * DAY_MS);
  const { deletedCount } = await PickingTask.deleteMany({
    status: 'completed',
    updatedAt: { $lt: cutoff },
  });
  return deletedCount || 0;
}

// Run the (non-TTL) sweeps now and then once a day. TTL-based log retention is
// handled by MongoDB itself via the indexes declared on the log schemas — only
// the filtered PickingTask purge needs an application-side timer. The interval is
// unref()'d so it never keeps the process alive on shutdown.
function startRetentionScheduler() {
  const runOnce = async () => {
    try {
      const n = await purgeOldCompletedPickingTasks();
      if (n) console.log(`[retention] purged ${n} completed picking task(s) older than ${COMPLETED_PICKING_RETENTION_DAYS}d`);
    } catch (err) {
      console.error('[retention] purge failed:', err?.message);
    }
  };
  runOnce();
  const timer = setInterval(runOnce, DAY_MS);
  timer.unref();
  return timer;
}

module.exports = {
  purgeOldCompletedPickingTasks,
  startRetentionScheduler,
  COMPLETED_PICKING_RETENTION_DAYS,
};
