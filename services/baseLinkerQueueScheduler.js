'use strict';

const { isBaseLinkerConfigured } = require('./baseLinkerClient');
const { getQueueScope } = require('./baseLinkerQueueScope');
const { syncBaseLinkerOrderIndex, INDEX_REFRESH_MS } = require('./baseLinkerOrderIndex');
const { runAsSchedulerLeader } = require('./schedulerLeader');

let timer = null;
let running = false;
let retryAfterMs = 0;
// Do not keep probing a token that BaseLinker has already rate-blocked.
const ERROR_BACKOFF_MS = Math.min(
  30 * 60_000,
  Math.max(60_000, Number(process.env.BASELINKER_QUEUE_ERROR_BACKOFF_MS) || (10 * 60_000)),
);

async function runBaseLinkerQueueTick() {
  if (!isBaseLinkerConfigured()) return { skipped: true, reason: 'not_configured' };
  if (Date.now() < retryAfterMs) return { skipped: true, reason: 'error_backoff', retryAfter: new Date(retryAfterMs).toISOString() };
  const scope = await getQueueScope();
  if (!scope.configured) return { skipped: true, reason: 'queue_not_configured' };
  try {
    const result = await runAsSchedulerLeader('baselinker-queue-index', () => syncBaseLinkerOrderIndex({ force: true }), { ttlMs: Math.max(60_000, INDEX_REFRESH_MS * 3) });
    retryAfterMs = 0;
    return result;
  } catch (error) {
    retryAfterMs = Date.now() + ERROR_BACKOFF_MS;
    throw error;
  }
}

function startBaseLinkerQueueScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runBaseLinkerQueueTick(); }
    catch (error) { console.error('[baselinker-queue-index]', error?.stack || error); }
    finally { running = false; }
  };
  tick();
  timer = setInterval(tick, INDEX_REFRESH_MS);
  timer.unref?.();
  return timer;
}

function isBaseLinkerQueueSchedulerStarted() {
  return Boolean(timer);
}

module.exports = {
  runBaseLinkerQueueTick,
  startBaseLinkerQueueScheduler,
  isBaseLinkerQueueSchedulerStarted,
  ERROR_BACKOFF_MS,
};
