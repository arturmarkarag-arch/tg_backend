'use strict';

const { getAllQueueScopes } = require('./baseLinkerQueueScope');
const {
  syncBaseLinkerOrderIndex,
  loadIndexState,
  INDEX_REFRESH_MS,
  POLL_FRESHNESS_MS,
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
  if (!accountId) return { skipped: true, reason: 'account_id_missing' };

  // One elected backend process owns the periodic Intake read for this account.
  // Re-read freshness inside the distributed lock so multiple backend processes
  // cannot run the same getOrders scan back-to-back.
  return runAsSchedulerLeader(
    `baselinker-queue-poll:${accountId}`,
    async () => {
      const freshState = await loadIndexState(accountId, scope);
      const ageMs = freshState.lastSyncAt
        ? Date.now() - Date.parse(freshState.lastSyncAt)
        : Number.POSITIVE_INFINITY;
      if (freshState.initialized && Number.isFinite(ageMs) && ageMs < POLL_FRESHNESS_MS) {
        return { baseLinkerAccountId: accountId, skipped: true, reason: 'queue_poll_fresh', lastSyncAt: freshState.lastSyncAt };
      }
      return syncBaseLinkerOrderIndex({ accountId, force: false, maxAgeMs: POLL_FRESHNESS_MS });
    },
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
