'use strict';

const { getAllQueueScopes } = require('./baseLinkerQueueScope');
const {
  syncBaseLinkerOrderIndex,
  syncBaseLinkerJournalDelta,
  loadIndexState,
  INDEX_REFRESH_MS,
  FULL_RECONCILE_MS,
} = require('./baseLinkerOrderIndex');
const { runAsSchedulerLeader } = require('./schedulerLeader');

let timer = null;
let running = false;
const retryAfterByAccount = new Map();
// Backoff is deliberately per account: one revoked/rate-blocked token must not
// pause the other BaseLinker connections.
const ERROR_BACKOFF_MS = Math.min(
  30 * 60_000,
  Math.max(60_000, Number(process.env.BASELINKER_QUEUE_ERROR_BACKOFF_MS) || (10 * 60_000)),
);

async function runAccountTick(scope) {
  const accountId = String(scope.baseLinkerAccountId || '');
  const state = await loadIndexState(accountId, scope);
  const fullAgeMs = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Number.POSITIVE_INFINITY;
  const needsFull = !state.initialized || !Number.isFinite(fullAgeMs) || fullAgeMs >= FULL_RECONCILE_MS;

  if (needsFull) {
    return runAsSchedulerLeader(
      `baselinker-queue-full:${accountId}`,
      () => syncBaseLinkerOrderIndex({ accountId, force: true, maxAgeMs: FULL_RECONCILE_MS }),
      { ttlMs: Math.max(120_000, FULL_RECONCILE_MS) },
    );
  }

  // If journal could not be primed (disabled account feature or simply no logs
  // in its 3-day window), do NOT hit it every 30 seconds forever. The next full
  // reconcile will retry priming while preserving queue correctness.
  if (!state.journalReady || !(state.journalLastLogId > 0)) {
    return { baseLinkerAccountId: accountId, skipped: true, reason: 'journal_not_ready_wait_full_reconcile' };
  }
  return runAsSchedulerLeader(
    `baselinker-queue-journal:${accountId}`,
    () => syncBaseLinkerJournalDelta(accountId),
    { ttlMs: Math.max(60_000, INDEX_REFRESH_MS * 2) },
  );
}

async function runBaseLinkerQueueTick() {
  const scopes = await getAllQueueScopes({ enabledOnly: true });
  if (!scopes.length) return { skipped: true, reason: 'not_configured', accounts: [] };

  const accounts = [];
  for (const scope of scopes) {
    const accountId = String(scope.baseLinkerAccountId || '');
    if (!accountId) continue;
    if (!scope.configured) {
      accounts.push({ baseLinkerAccountId: accountId, skipped: true, reason: 'queue_not_configured' });
      continue;
    }
    const retryAfterMs = Number(retryAfterByAccount.get(accountId) || 0);
    if (Date.now() < retryAfterMs) {
      accounts.push({
        baseLinkerAccountId: accountId,
        skipped: true,
        reason: 'error_backoff',
        retryAfter: new Date(retryAfterMs).toISOString(),
      });
      continue;
    }
    try {
      const result = await runAccountTick(scope);
      retryAfterByAccount.delete(accountId);
      accounts.push(result);
    } catch (error) {
      retryAfterByAccount.set(accountId, Date.now() + ERROR_BACKOFF_MS);
      accounts.push({ baseLinkerAccountId: accountId, error: error?.code || error?.message || 'sync_failed' });
    }
  }
  return {
    accounts,
    synced: accounts.filter((row) => !row.skipped && !row.error).length,
    failed: accounts.filter((row) => row.error).length,
  };
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

function resetBaseLinkerQueueSchedulerBackoffForTests() {
  retryAfterByAccount.clear();
}

module.exports = {
  runBaseLinkerQueueTick,
  startBaseLinkerQueueScheduler,
  isBaseLinkerQueueSchedulerStarted,
  resetBaseLinkerQueueSchedulerBackoffForTests,
  ERROR_BACKOFF_MS,
};
