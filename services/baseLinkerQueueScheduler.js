'use strict';

const { isBaseLinkerConfigured } = require('./baseLinkerClient');
const { getQueueScope } = require('./baseLinkerQueueScope');
const { syncBaseLinkerOrderIndex, INDEX_REFRESH_MS } = require('./baseLinkerOrderIndex');
const { runAsSchedulerLeader } = require('./schedulerLeader');

let timer = null;
let running = false;

async function runBaseLinkerQueueTick() {
  if (!isBaseLinkerConfigured()) return { skipped: true, reason: 'not_configured' };
  const scope = await getQueueScope();
  if (!scope.configured) return { skipped: true, reason: 'queue_not_configured' };
  return runAsSchedulerLeader('baselinker-queue-index', () => syncBaseLinkerOrderIndex({ force: true }), { ttlMs: Math.max(60_000, INDEX_REFRESH_MS * 3) });
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
};
