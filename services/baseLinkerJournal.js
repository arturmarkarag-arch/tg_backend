'use strict';

const AppSetting = require('../models/AppSetting');
const { callBaseLinker, isBaseLinkerConfigured } = require('./baseLinkerClient');
const { syncBaseLinkerOrderCache, refreshBaseLinkerOrderCache, getKnownCachedOrderIds } = require('./baseLinkerOrderCache');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { reconcilePickingFromUpstreamChanges, markPickingOrdersUpstreamUpdated } = require('./baseLinkerPicking');
const { getQueueScope } = require('./baseLinkerQueueScope');
const { syncErrorDetails, retryDelayMs } = require('./baseLinkerSyncError');
const { runAsSchedulerLeader } = require('./schedulerLeader');
const { getIO } = require('../socket');
const { getBaseLinkerAccountScope, scopedSettingKey, scopedLockKey } = require('./baseLinkerAccount');

const JOURNAL_STATE_KEY = 'baselinker.journal.v1';
const TICK_MS = Math.min(60_000, Math.max(5_000, Number(process.env.BASELINKER_JOURNAL_POLL_MS) || 15_000));
const MAX_CHANGED_ORDERS_PER_TICK = Math.min(20, Math.max(1, Number(process.env.BASELINKER_JOURNAL_MAX_ORDERS_PER_TICK) || 6));
const BOOTSTRAP_PAGES_PER_TICK = Math.min(20, Math.max(1, Number(process.env.BASELINKER_JOURNAL_BOOTSTRAP_PAGES_PER_TICK) || 6));
const DEGRADED_RECONCILE_MS = Math.min(5 * 60_000, Math.max(30_000, Number(process.env.BASELINKER_DEGRADED_RECONCILE_MS) || 60_000));

// Events that can change anything visible/operational on the worker screen.
// Invoice/receipt/package/payment/status changes are included because an order
// already touched by warehouse staff must surface in Updated after ANY upstream change.
// Type 15 is blacklist-only and does not mutate the order itself.
const JOURNAL_LOG_TYPES = Object.freeze([
  1,  // order creation
  2,  // order confirmation / DOF
  3,  // payment change
  4,  // order / invoice / receipt removal
  5,  // merge
  6,  // split
  7,  // invoice issued
  8,  // receipt issued
  9,  // package creation
  10, // package deletion
  11, // delivery data edit
  12, // product added
  13, // product edited
  14, // product removed
  // 15 = blacklist only; it does not change the warehouse order itself.
  16, // order data edited
  17, // copied order
  18, // order status changed
  19, // invoice deleted
  20, // receipt deleted
  21, // invoice data edited
  22, // package status changed
]);
const JOURNAL_LOG_TYPE_SET = new Set(JOURNAL_LOG_TYPES);
const OBJECT_ID_IS_ORDER_ID = new Set([5, 6, 17]);

let timer = null;
let running = false;
let warnedPossiblyDisabled = false;

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function logIdOf(log) {
  // BaseLinker docs currently describe the field as `id`, while their own
  // sample response uses `log_id`. Accept both so a docs/API naming drift does
  // not break the cursor.
  return positiveInt(log?.log_id ?? log?.id);
}

function normalizeJournalLogs(logs, afterLogId = 0) {
  const after = positiveInt(afterLogId);
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => logIdOf(log) > after)
    .sort((a, b) => logIdOf(a) - logIdOf(b));
}

function affectedOrderIdsForLog(log) {
  const type = Number(log?.log_type);
  if (!JOURNAL_LOG_TYPE_SET.has(type)) return [];
  const ids = new Set();
  const orderId = positiveInt(log?.order_id);
  if (orderId) ids.add(String(orderId));
  if (OBJECT_ID_IS_ORDER_ID.has(type)) {
    const relatedOrderId = positiveInt(log?.object_id);
    if (relatedOrderId) ids.add(String(relatedOrderId));
  }
  return [...ids];
}

function selectJournalWindow(logs, maxUniqueOrders = MAX_CHANGED_ORDERS_PER_TICK) {
  const selected = [];
  const orderIds = new Set();
  let cutoffLogId = 0;

  for (const log of Array.isArray(logs) ? logs : []) {
    const ids = affectedOrderIdsForLog(log);
    const additions = ids.filter((id) => !orderIds.has(id));
    // Always consume at least one log even if a split/merge references two order
    // IDs and the configured max is 1; otherwise the cursor could never move.
    if (selected.length > 0 && orderIds.size + additions.length > maxUniqueOrders) break;
    selected.push(log);
    cutoffLogId = logIdOf(log);
    additions.forEach((id) => orderIds.add(id));
  }

  return { selected, orderIds: [...orderIds], cutoffLogId };
}

async function loadJournalState() {
  const row = await AppSetting.findOne({
    key: scopedSettingKey(JOURNAL_STATE_KEY, getBaseLinkerAccountScope()),
  }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    initialized: value.initialized === true,
    scopeKey: value.scopeKey || null,
    lastLogId: positiveInt(value.lastLogId),
    lastSuccessAt: value.lastSuccessAt || null,
    lastChangeAt: value.lastChangeAt || null,
    possiblyDisabled: value.possiblyDisabled === true,
    lastError: value.lastError || null,
    failureCount: Number(value.failureCount || 0),
    nextRetryAt: value.nextRetryAt || null,
  };
}

async function saveJournalState(state) {
  const value = {
    initialized: state.initialized === true,
    scopeKey: state.scopeKey || null,
    lastLogId: positiveInt(state.lastLogId),
    lastSuccessAt: state.lastSuccessAt || null,
    lastChangeAt: state.lastChangeAt || null,
    possiblyDisabled: state.possiblyDisabled === true,
    lastError: state.lastError || null,
    failureCount: Number(state.failureCount || 0),
    nextRetryAt: state.nextRetryAt || null,
  };
  await AppSetting.findOneAndUpdate(
    { key: scopedSettingKey(JOURNAL_STATE_KEY, getBaseLinkerAccountScope()) },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return value;
}

async function fetchJournal(lastLogId, callApi = callBaseLinker) {
  return callApi('getJournalList', {
    last_log_id: positiveInt(lastLogId) || 1,
    logs_types: JOURNAL_LOG_TYPES,
  });
}

function emitOrdersChanged(payload) {
  try {
    const io = getIO();
    if (!io) return;
    io.to('baselinker_staff').emit('baselinker_orders_changed', { accountScope: getBaseLinkerAccountScope(), ...(payload || {}) });
  } catch (_) {
    // Realtime is best-effort. Journal cursor is persisted only after the
    // upstream/local reconciliation succeeded, not after socket delivery.
  }
}

async function bootstrapJournal(state) {
  let cursor = positiveInt(state.lastLogId) || 1;
  let sawAny = false;

  for (let page = 0; page < BOOTSTRAP_PAGES_PER_TICK; page += 1) {
    const payload = await fetchJournal(cursor);
    const logs = normalizeJournalLogs(payload?.logs, cursor);
    if (!logs.length) {
      const now = new Date().toISOString();
      const possiblyDisabled = !sawAny && cursor === 1;
      // Close the gap between the initial snapshot and journal high-water mark.
      await syncBaseLinkerOrderCache({ force: true });
      const next = await saveJournalState({
        ...state,
        initialized: true,
        lastLogId: cursor,
        lastSuccessAt: now,
        possiblyDisabled,
      });
      if (possiblyDisabled && !warnedPossiblyDisabled) {
        warnedPossiblyDisabled = true;
        console.warn('[baselinker-journal] getJournalList returned no events during bootstrap; the method may be disabled in Base API settings');
      }
      // Notify connected clients that the scoped queue is ready to read.
      emitOrdersChanged({ resync: true, reason: 'journal_bootstrap_complete', journalLastLogId: cursor, fetchedAt: now });
      return { initialized: true, lastLogId: cursor, bootstrapped: true, state: next };
    }

    sawAny = true;
    const nextCursor = logIdOf(logs[logs.length - 1]);
    if (!nextCursor || nextCursor <= cursor) throw new Error('BaseLinker journal cursor did not advance during bootstrap');
    cursor = nextCursor;
  }

  await saveJournalState({
    ...state,
    initialized: false,
    lastLogId: cursor,
    lastSuccessAt: new Date().toISOString(),
    possiblyDisabled: false,
  });
  return { initialized: false, lastLogId: cursor, bootstrapped: false };
}

async function runBaseLinkerJournalTick() {
  if (!isBaseLinkerConfigured()) return { skipped: true, reason: 'not_configured' };
  const scope = await getQueueScope();
  if (!scope.configured) return { skipped: true, reason: 'queue_not_configured' };

  return runAsSchedulerLeader(scopedLockKey('baselinker-journal', scope.accountScope), async () => {
    const state = await loadJournalState();
    if (state.scopeKey === scope.scopeKey && Date.parse(state.nextRetryAt) > Date.now()) return { skipped: true, reason: 'backoff' };
    const healthy = { ...state, scopeKey: scope.scopeKey, lastError: null, failureCount: 0, nextRetryAt: null };
    try {
      // Periodic scoped reconciliation also recovers when journal is disabled
      // or its three-day history no longer covers our saved cursor.
      const synced = await syncBaseLinkerOrderCache({
        maxAgeMs: state.possiblyDisabled === true ? DEGRADED_RECONCILE_MS : undefined,
      });
      if (!synced.skipped) emitOrdersChanged({ resync: true, reason: 'queue_sync', fetchedAt: new Date().toISOString() });
      if (!state.initialized) return await bootstrapJournal(healthy);

      const payload = await fetchJournal(state.lastLogId);
      const logs = normalizeJournalLogs(payload?.logs, state.lastLogId);
      const window = selectJournalWindow(logs);
      const journalTypesByOrderId = {};
      for (const log of window.selected) {
        const type = Number(log?.log_type);
        for (const orderId of affectedOrderIdsForLog(log)) {
          if (!journalTypesByOrderId[orderId]) journalTypesByOrderId[orderId] = [];
          journalTypesByOrderId[orderId].push(type);
        }
      }

      const exactOrders = [];
      const removedOrderIds = [];
      for (const orderId of window.orderIds) {
        const exact = await fetchBaseLinkerOrders({ orderId, includeUnconfirmed: true, maxPages: 1 });
        const order = (exact.orders || []).find((candidate) => String(candidate?.order_id) === String(orderId));
        if (order) exactOrders.push(order);
        else removedOrderIds.push(String(orderId));
      }

      if (window.orderIds.length) {
        // Capture membership BEFORE refreshing the cache. Cancellation is a
        // special attention event: even an untouched order that was already on
        // our intake shelf must remain visible in Updated until "Прийнято".
        const knownCachedOrderIds = await getKnownCachedOrderIds(window.orderIds);
        // BaseLinker stays authoritative. Journal tells us exactly WHICH order
        // changed; refresh only those snapshots instead of rescanning the full
        // queue. Locally tracked orders are retained even after their upstream
        // status leaves the intake queue.
        await reconcilePickingFromUpstreamChanges({ orders: exactOrders, removedOrderIds });
        await markPickingOrdersUpstreamUpdated({
          orderIds: window.orderIds,
          journalTypesByOrderId,
          orders: exactOrders,
          knownCachedOrderIds,
        });
        await refreshBaseLinkerOrderCache({ orders: exactOrders, removedOrderIds });
      }

      const now = new Date().toISOString();
      const lastLogId = window.cutoffLogId || (state.lastLogId || 1);
      await saveJournalState({
        ...healthy,
        initialized: true,
        lastLogId,
        lastSuccessAt: now,
        lastChangeAt: window.selected.length ? now : state.lastChangeAt,
        possiblyDisabled: window.selected.length ? false : state.possiblyDisabled,
      });
      if (window.selected.length) emitOrdersChanged({
        resync: true,
        reason: 'journal_order_refresh',
        orderIds: window.orderIds,
        journalLastLogId: lastLogId,
        fetchedAt: now,
      });
      return { changed: window.selected.length, ordersRefreshed: window.orderIds.length, lastLogId };
    } catch (error) {
      const failureCount = (state.scopeKey === scope.scopeKey ? state.failureCount : 0) + 1;
      const lastError = syncErrorDetails(error);
      const nextRetryAt = new Date(Date.now() + retryDelayMs(error, failureCount)).toISOString();
      // Keep the previous cursor so a failed sync is retried without losing events.
      await saveJournalState({ ...state, scopeKey: scope.scopeKey, failureCount, lastError, nextRetryAt });
      console.warn('[baselinker-journal] scheduler tick failed', { ...lastError, nextRetryAt });
      return { failed: true, lastError, nextRetryAt };
    }
  }, { ttlMs: 30 * 60_000 });
}

function startBaseLinkerJournalScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runBaseLinkerJournalTick();
    } catch (err) {
      console.warn('[baselinker-journal] scheduler tick failed', syncErrorDetails(err));
    } finally {
      running = false;
    }
  };

  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}

function stopBaseLinkerJournalScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function isBaseLinkerJournalSchedulerStarted() {
  return Boolean(timer);
}

module.exports = {
  JOURNAL_STATE_KEY,
  JOURNAL_LOG_TYPES,
  TICK_MS,
  MAX_CHANGED_ORDERS_PER_TICK,
  DEGRADED_RECONCILE_MS,
  logIdOf,
  normalizeJournalLogs,
  affectedOrderIdsForLog,
  selectJournalWindow,
  fetchJournal,
  loadJournalState,
  runBaseLinkerJournalTick,
  startBaseLinkerJournalScheduler,
  stopBaseLinkerJournalScheduler,
  isBaseLinkerJournalSchedulerStarted,
};
