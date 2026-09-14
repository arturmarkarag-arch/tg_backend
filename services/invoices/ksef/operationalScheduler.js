'use strict';

const { runAsSchedulerLeader } = require('../../schedulerLeader');
const { recoverStaleKsefLeases, cleanupKsefOperationalState } = require('./operations');
const { recordOperationalEventBestEffort } = require('./operationalTelemetry');

const TICK_MS = Math.max(5 * 60_000, Number(process.env.KSEF_OPERATIONS_TICK_MS) || 15 * 60_000);
let timer = null;

async function runKsefOperationalTick() {
  return runAsSchedulerLeader('ksef-operational-maintenance', async () => {
    const recovery = await recoverStaleKsefLeases({ source: 'scheduler' });
    const cleanup = await cleanupKsefOperationalState();
    return { recovery, cleanup };
  }, { ttlMs: Math.max(60_000, Math.floor(TICK_MS / 2)) });
}
function startKsefOperationalScheduler() {
  if (timer) return timer;
  if (String(process.env.KSEF_OPERATIONS_ENABLED || 'true').toLowerCase() === 'false') return null;
  const tick = async () => {
    try { await runKsefOperationalTick(); }
    catch (error) {
      console.error('[ksef-operational-scheduler]', error?.stack || error);
      recordOperationalEventBestEffort({ kind: 'scheduler_error', severity: 'error', code: error?.code || 'ksef_operational_scheduler_failed', message: error?.message || String(error), resourceType: 'operational_scheduler' });
    }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return timer;
}
function isKsefOperationalSchedulerStarted() { return Boolean(timer); }
module.exports = { TICK_MS, runKsefOperationalTick, startKsefOperationalScheduler, isKsefOperationalSchedulerStarted };
