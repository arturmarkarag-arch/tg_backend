'use strict';

const { listAllegroAccounts } = require('./allegroAccounts');
const { syncOneAllegroAccount, syncAllegroOrderImages, getAllegroOrderSyncStates, setAllegroOrderRetryAt } = require('./allegroOrders');
const { runAsSchedulerLeader } = require('./schedulerLeader');

const ORDER_POLL_MS = Math.min(60_000, Math.max(3_000, Number(process.env.ALLEGRO_ORDER_POLL_MS) || 5_000));
const DEFAULT_ERROR_BACKOFF_MS = Math.min(10 * 60_000, Math.max(5_000, Number(process.env.ALLEGRO_ORDER_ERROR_BACKOFF_MS) || 15_000));

let timer = null;
const inFlight = new Set();
const imagesInFlight = new Set();

function scheduleImages(accountId) {
  if (imagesInFlight.has(accountId)) return;
  imagesInFlight.add(accountId);
  // Independent lane: a stalled photo must never delay the next order poll.
  Promise.resolve().then(() => syncAllegroOrderImages(accountId))
    .catch((error) => { if (error?.code !== 'lock_busy') console.warn('[allegro-image-scheduler]', error?.code || 'image_sync_failed'); })
    .finally(() => imagesInFlight.delete(accountId));
}

function normalizedBackoff(error) {
  const upstream = Number(error?.args?.retryAfterMs || 0);
  if (Number.isFinite(upstream) && upstream > 0) return Math.min(30 * 60_000, Math.max(5_000, upstream));
  return DEFAULT_ERROR_BACKOFF_MS;
}

async function runAccountTick(account) {
  const accountId = String(account?.accountId || '').trim();
  if (!accountId) return { skipped: true, reason: 'account_id_missing' };
  return runAsSchedulerLeader(
    `allegro-order-poll:${accountId}`,
    () => syncOneAllegroAccount(accountId),
    { ttlMs: Math.max(60_000, ORDER_POLL_MS * 3) },
  );
}

async function runAllegroOrderTick() {
  const accounts = await listAllegroAccounts({ includeDisabled: false });
  const enabled = accounts.filter((account) => account.enabled === true && account.authState === 'connected' && account.orderIngestReady !== false);
  if (!enabled.length) return { skipped: true, reason: 'not_configured', accounts: [] };

  // Accounts are isolated jobs. A timeout/cooldown on one seller must not
  // head-of-line block every other Allegro shop in the same scheduler tick.
  // Stage 3's app-wide limiter remains the authority for aggregate Client ID traffic.
  const syncStates = await getAllegroOrderSyncStates(enabled.map((account) => account.accountId));
  const syncByAccountId = new Map(syncStates.map((row) => [String(row.accountId || ''), row]));
  const results = await Promise.all(enabled.map(async (account) => {
    const accountId = String(account.accountId || '').trim();
    if (inFlight.has(accountId)) return { accountId, skipped: true, reason: 'account_busy' };
    const sync = syncByAccountId.get(accountId) || {};
    const retryAt = sync?.nextRetryAt ? new Date(sync.nextRetryAt).getTime() : 0;
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return { accountId, skipped: true, reason: 'error_backoff', retryAfter: new Date(retryAt).toISOString() };
    }
    inFlight.add(accountId);
    try {
      const result = await runAccountTick(account);
      if (!result?.skipped) await setAllegroOrderRetryAt(accountId, null);
      if (result?.caughtUp) scheduleImages(accountId);
      return result;
    } catch (error) {
      const backoffMs = normalizedBackoff(error);
      const retryAtDate = new Date(Date.now() + backoffMs);
      await setAllegroOrderRetryAt(accountId, retryAtDate);
      return {
        accountId,
        error: error?.code || error?.message || 'allegro_order_sync_failed',
        retryAfterMs: backoffMs,
        retryAfter: retryAtDate.toISOString(),
      };
    } finally {
      inFlight.delete(accountId);
    }
  }));
  return {
    accounts: results,
    synced: results.filter((row) => !row.skipped && !row.error).length,
    failed: results.filter((row) => row.error).length,
  };
}

function startAllegroOrderScheduler() {
  if (timer) return timer;
  const tick = async () => {
    try { await runAllegroOrderTick(); }
    catch (error) { console.error('[allegro-order-scheduler]', error?.stack || error); }
  };
  tick();
  timer = setInterval(tick, ORDER_POLL_MS);
  timer.unref?.();
  return timer;
}

function isAllegroOrderSchedulerStarted() {
  return Boolean(timer);
}

function resetAllegroOrderSchedulerBackoffForTests() {
  // Backoff is persisted in AllegroOrderSyncState; tests should clear the model
  // fixture instead of mutating process-local scheduler state.
}

module.exports = {
  ORDER_POLL_MS,
  DEFAULT_ERROR_BACKOFF_MS,
  runAllegroOrderTick,
  startAllegroOrderScheduler,
  isAllegroOrderSchedulerStarted,
  resetAllegroOrderSchedulerBackoffForTests,
};
