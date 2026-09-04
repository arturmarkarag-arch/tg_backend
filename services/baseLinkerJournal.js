'use strict';

const AppSetting = require('../models/AppSetting');
const { callBaseLinker, isBaseLinkerConfigured } = require('./baseLinkerClient');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { fetchBaseLinkerProductCatalog } = require('./baseLinkerProducts');
const { getPickingStates, reconcilePickingFromUpstreamChanges } = require('./baseLinkerPicking');
const { runAsSchedulerLeader } = require('./schedulerLeader');
const { getIO } = require('../socket');

const JOURNAL_STATE_KEY = 'baselinker.journal.v1';
const TICK_MS = Math.min(60_000, Math.max(5_000, Number(process.env.BASELINKER_JOURNAL_POLL_MS) || 15_000));
const MAX_CHANGED_ORDERS_PER_TICK = Math.min(20, Math.max(1, Number(process.env.BASELINKER_JOURNAL_MAX_ORDERS_PER_TICK) || 6));
const BOOTSTRAP_PAGES_PER_TICK = Math.min(20, Math.max(1, Number(process.env.BASELINKER_JOURNAL_BOOTSTRAP_PAGES_PER_TICK) || 6));

// Events that can change anything visible/operational on the worker screen.
// Invoice/receipt/blacklist-only events are intentionally ignored.
const JOURNAL_LOG_TYPES = Object.freeze([
  1,  // order creation
  2,  // order confirmation / DOF
  4,  // order removal
  5,  // merge
  6,  // split
  9,  // package creation
  10, // package deletion
  11, // delivery data edit
  12, // product added
  13, // product edited
  14, // product removed
  16, // order data edited
  17, // copied order
  18, // order status changed
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
  const row = await AppSetting.findOne({ key: JOURNAL_STATE_KEY }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    initialized: value.initialized === true,
    lastLogId: positiveInt(value.lastLogId),
    lastSuccessAt: value.lastSuccessAt || null,
    lastChangeAt: value.lastChangeAt || null,
    possiblyDisabled: value.possiblyDisabled === true,
  };
}

async function saveJournalState(state) {
  const value = {
    initialized: state.initialized === true,
    lastLogId: positiveInt(state.lastLogId),
    lastSuccessAt: state.lastSuccessAt || null,
    lastChangeAt: state.lastChangeAt || null,
    possiblyDisabled: state.possiblyDisabled === true,
  };
  await AppSetting.findOneAndUpdate(
    { key: JOURNAL_STATE_KEY },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return value;
}

async function fetchJournal(lastLogId, callApi = callBaseLinker) {
  return callApi('getJournalList', {
    last_log_id: positiveInt(lastLogId),
    logs_types: JOURNAL_LOG_TYPES,
  });
}

async function fetchExactOrderOrNull(orderId) {
  const result = await fetchBaseLinkerOrders({
    orderId,
    includeUnconfirmed: true,
    maxPages: 1,
  });
  return (result.orders || []).find((order) => String(order?.order_id) === String(orderId)) || null;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const input = Array.from(values || []);
  const out = new Array(input.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), input.length || 1) }, async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= input.length) return;
      out[index] = await mapper(input[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function refreshChangedOrders(orderIds) {
  const ids = [...new Set((orderIds || []).map(String).filter(Boolean))];
  const rows = await mapWithConcurrency(ids, 2, async (orderId) => ({
    orderId,
    order: await fetchExactOrderOrNull(orderId),
  }));
  const upserts = rows.filter((row) => row.order).map((row) => row.order);
  const removedOrderIds = rows.filter((row) => !row.order).map((row) => row.orderId);
  return { upserts, removedOrderIds };
}

function emitOrdersChanged(payload) {
  try {
    const io = getIO();
    if (!io) return;
    io.to('baselinker_staff').emit('baselinker_orders_changed', payload);
  } catch (_) {
    // Realtime is best-effort. Journal cursor is persisted only after the
    // upstream/local reconciliation succeeded, not after socket delivery.
  }
}

async function enrichChangedOrders(orders) {
  if (!orders.length) return { productCatalog: {}, productCatalogWarnings: [] };
  try {
    return await fetchBaseLinkerProductCatalog(orders);
  } catch (error) {
    return {
      productCatalog: {},
      productCatalogWarnings: [{ scope: 'journal_catalog', code: error?.code || error?.message || 'catalog_lookup_failed' }],
    };
  }
}

async function bootstrapJournal(state) {
  let cursor = positiveInt(state.lastLogId);
  let sawAny = false;

  for (let page = 0; page < BOOTSTRAP_PAGES_PER_TICK; page += 1) {
    const payload = await fetchJournal(cursor);
    const logs = normalizeJournalLogs(payload?.logs, cursor);
    if (!logs.length) {
      const now = new Date().toISOString();
      const possiblyDisabled = !sawAny && cursor === 0;
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
      // One full reconciliation after the initial high-water mark is enough.
      // Existing clients fetch current truth once; afterwards every change is a
      // small socket patch rather than continuous list polling.
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

  return runAsSchedulerLeader('baselinker-journal', async () => {
    const state = await loadJournalState();
    if (!state.initialized) return bootstrapJournal(state);

    const payload = await fetchJournal(state.lastLogId);
    const logs = normalizeJournalLogs(payload?.logs, state.lastLogId);
    if (!logs.length) return { changed: 0, lastLogId: state.lastLogId };

    const window = selectJournalWindow(logs);
    if (!window.selected.length || !window.cutoffLogId) return { changed: 0, lastLogId: state.lastLogId };

    const { upserts, removedOrderIds } = await refreshChangedOrders(window.orderIds);

    // Keep an already-open picking task consistent with the fresh BaseLinker
    // snapshot before we push it to workers. This preserves unchanged ticks,
    // resets only changed/new lines, and prevents the UI from showing a new qty
    // while Mongo still validates against the old qty.
    await reconcilePickingFromUpstreamChanges({ orders: upserts, removedOrderIds });

    const [catalog, pickingStates] = await Promise.all([
      enrichChangedOrders(upserts),
      getPickingStates(window.orderIds),
    ]);

    const now = new Date().toISOString();
    emitOrdersChanged({
      resync: false,
      orders: upserts,
      removedOrderIds,
      productCatalog: catalog.productCatalog || {},
      productCatalogWarnings: catalog.productCatalogWarnings || [],
      pickingStates,
      journalLastLogId: window.cutoffLogId,
      fetchedAt: now,
    });

    await saveJournalState({
      ...state,
      initialized: true,
      lastLogId: window.cutoffLogId,
      lastSuccessAt: now,
      lastChangeAt: now,
      possiblyDisabled: false,
    });

    return {
      changed: window.orderIds.length,
      upserts: upserts.length,
      removed: removedOrderIds.length,
      lastLogId: window.cutoffLogId,
      remainingInBatch: Math.max(0, logs.length - window.selected.length),
    };
  }, { ttlMs: 5 * 60 * 1000 });
}

function startBaseLinkerJournalScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runBaseLinkerJournalTick();
    } catch (err) {
      console.warn('[baselinker-journal] scheduler tick failed', err?.code || err?.message || err);
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

module.exports = {
  JOURNAL_STATE_KEY,
  JOURNAL_LOG_TYPES,
  TICK_MS,
  MAX_CHANGED_ORDERS_PER_TICK,
  logIdOf,
  normalizeJournalLogs,
  affectedOrderIdsForLog,
  selectJournalWindow,
  fetchJournal,
  runBaseLinkerJournalTick,
  startBaseLinkerJournalScheduler,
  stopBaseLinkerJournalScheduler,
};
