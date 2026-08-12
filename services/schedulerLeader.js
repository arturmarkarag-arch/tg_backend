'use strict';

const { withLock } = require('../utils/lock');

/**
 * Run one scheduler tick on at most one Redis-connected instance.
 *
 * - With Redis: distributed SET-NX lock -> one horizontal Render instance wins.
 * - Without Redis: utils/lock falls back to the existing process-local mutex,
 *   which is sufficient for supported single-instance/local development.
 * - waitMs=0: schedulers never queue behind the leader; the next interval is the
 *   retry. A missed duplicate tick is preferable to a thundering herd.
 */
async function runAsSchedulerLeader(name, work, { ttlMs = 5 * 60 * 1000 } = {}) {
  try {
    return await withLock(`scheduler:${String(name)}`, work, { ttlMs, waitMs: 0 });
  } catch (err) {
    if (err?.code === 'lock_busy') return { skipped: true, reason: 'leader_busy' };
    throw err;
  }
}

module.exports = { runAsSchedulerLeader };
