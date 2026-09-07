'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { compactOrder } = require('./baseLinkerPublicDto');
const { getCachedBaseLinkerProductCatalog, warmBaseLinkerProductCatalog } = require('./baseLinkerProducts');
const { annotateOrder, orderKey, resolveSourceName } = require('./baseLinkerIdentity');
const { makeBaseLinkerAccountCaller, BASELINKER_REQUEST_BUDGET_PER_MINUTE } = require('./baseLinkerClient');
const { listBaseLinkerAccounts, getBaseLinkerAccount, recordAccountSync } = require('./baseLinkerAccounts');
const {
  getQueueScope,
  getAllQueueScopes,
  classifyUpstreamOrder,
  HISTORY_RETENTION_DAYS,
} = require('./baseLinkerQueueScope');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');

const INDEX_STATE_KEY = 'baselinker.orderIndex.v3';
// Scheduler tick can stay frequent because most ticks are journal deltas. Full
// status reconciliation is intentionally much slower and is the safety net.
const INDEX_REFRESH_MS = Math.min(5 * 60_000, Math.max(15_000, Number(process.env.BASELINKER_QUEUE_REFRESH_MS) || 30_000));
const FULL_RECONCILE_MS = Math.max(2 * 60_000, Number(process.env.BASELINKER_QUEUE_FULL_RECONCILE_MS) || (5 * 60_000));
const JOURNAL_MAX_EXACT_PER_TICK = Math.min(20, Math.max(1, Number(process.env.BASELINKER_JOURNAL_MAX_EXACT_PER_TICK) || 8));
const JOURNAL_LOG_TYPES = Object.freeze([1, 4, 5, 6, 11, 12, 13, 14, 16, 17, 18]);
const FULL_SCAN_PRODUCT_WARM_REQUESTS = Math.min(10, Math.max(0, Number(process.env.BASELINKER_FULL_SCAN_PRODUCT_WARM_REQUESTS) || 5));
const DELTA_PRODUCT_WARM_REQUESTS = Math.min(5, Math.max(0, Number(process.env.BASELINKER_DELTA_PRODUCT_WARM_REQUESTS) || 2));
const SCANS_PER_MINUTE = Math.max(1, Math.ceil(60_000 / FULL_RECONCILE_MS));
// Reserve part of every token budget for exact departure verification, selected
// page hydration, metadata checks and operator mutations. Increasing queue size
// safely therefore requires a slower refresh cadence rather than bypassing the
// BaseLinker token limit.
const SYNC_REQUEST_RESERVE_PER_MINUTE = Math.min(40, Math.max(20, Number(process.env.BASELINKER_QUEUE_REQUEST_RESERVE) || 30));
const SAFE_INDEX_PAGES_PER_SCAN = Math.max(1, Math.floor((BASELINKER_REQUEST_BUDGET_PER_MINUTE - SYNC_REQUEST_RESERVE_PER_MINUTE) / SCANS_PER_MINUTE));
const REQUESTED_INDEX_MAX_PAGES = Math.max(1, Number(process.env.BASELINKER_QUEUE_MAX_PAGES) || SAFE_INDEX_PAGES_PER_SCAN);
const INDEX_MAX_PAGES = Math.min(60, SAFE_INDEX_PAGES_PER_SCAN, REQUESTED_INDEX_MAX_PAGES);
const DEPARTURE_VERIFY_LIMIT = Math.min(15, Math.max(1, Number(process.env.BASELINKER_DEPARTURE_VERIFY_LIMIT) || 10));
const TRACKED_REVERIFY_LIMIT = Math.min(10, Math.max(1, Number(process.env.BASELINKER_TRACKED_REVERIFY_LIMIT) || 4));
const TRACKED_REVERIFY_STALE_MS = Math.max(15_000, Number(process.env.BASELINKER_TRACKED_REVERIFY_MS) || INDEX_REFRESH_MS);
const VISIBLE_TRACKED_REVERIFY_LIMIT = Math.min(4, Math.max(1, Number(process.env.BASELINKER_VISIBLE_REVERIFY_LIMIT) || 2));
const PAGE_SIZE_VALUES = new Set([10, 20]);
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
let indexReadyPromise = null;
const syncInFlightByAccount = new Map();
const intakeSearchCacheByAccount = new Map();
const SEARCH_CACHE_MAX_AGE_MS = Math.max(INDEX_REFRESH_MS * 2, 60_000);

function stateKey(accountId) { return `${INDEX_STATE_KEY}:${String(accountId || '')}`; }
function normalizePage(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 1; }
function pageSize(value) { const n = Number(value); return PAGE_SIZE_VALUES.has(n) ? n : 10; }
function orderIdString(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? String(n) : ''; }
function accountIdString(value) { return String(value || '').trim(); }
function rowKey(accountId, orderId) { return orderKey(accountIdString(accountId), orderIdString(orderId)); }

function localDisplayStage(doc) {
  const disposition = String(doc?.upstreamDisposition || '');
  // Configured Sent/Cancelled are terminal business outcomes. A later
  // cancellation is shown on the Cancelled shelf while any previously recorded
  // Sent/packing history remains available on the PickingOrder audit trail.
  if (disposition === 'cancelled') return 'cancelled';
  if (String(doc?.status || '') === 'sent' || String(doc?.workflowStage || '') === 'sent') return 'sent';
  if (String(doc?.workflowStage || '') === 'packed' || String(doc?.status || '') === 'packed') return 'packed';
  if (disposition && disposition !== 'intake') return 'deferred';
  if (String(doc?.workflowStage || '') === 'deferred' || ['paused', 'problem', 'ready_to_pack_with_issue'].includes(String(doc?.status || ''))) return 'deferred';
  return 'processing';
}

function pickingSearchText(doc) {
  return [
    doc?.orderId, doc?.sourceShopOrderId, doc?.sourceExternalOrderId,
    doc?.baseLinkerAccountNameSnapshot, doc?.sourceType, doc?.sourceId,
    doc?.sourceNameSnapshot, doc?.sourceNameLastKnown,
    ...(Array.isArray(doc?.items) ? doc.items.flatMap((item) => [item?.name, item?.sku, item?.ean, item?.productId, item?.variantId, item?.orderProductId]) : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function orderOperationalSearchText(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  return [
    order?.order_id, order?.shop_order_id, order?.external_order_id,
    order?.order_source, order?.order_source_id,
    ...products.flatMap((item) => [
      item?.name, item?.sku, item?.ean, item?.product_id, item?.variant_id, item?.order_product_id,
    ]),
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 4096);
}

function cacheIntakeSearch(scope, orders) {
  const accountId = accountIdString(scope?.baseLinkerAccountId);
  if (!accountId) return;
  const byId = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    const id = orderIdString(order?.order_id);
    if (id) byId.set(id, orderOperationalSearchText(order));
  }
  intakeSearchCacheByAccount.set(accountId, {
    scopeKey: String(scope?.scopeKey || ''),
    fetchedAt: Date.now(),
    byId,
  });
}

async function ensureIntakeSearchCache(scope) {
  const accountId = accountIdString(scope?.baseLinkerAccountId);
  const cached = intakeSearchCacheByAccount.get(accountId);
  const fresh = cached
    && cached.scopeKey === String(scope?.scopeKey || '')
    && (Date.now() - Number(cached.fetchedAt || 0)) < SEARCH_CACHE_MAX_AGE_MS;
  if (fresh) return cached.byId;
  // One generic operational search snapshot serves every search term during its
  // TTL. We never persist the full BaseLinker order or customer PII.
  await scanIntake(scope);
  return intakeSearchCacheByAccount.get(accountId)?.byId || new Map();
}


function orderFromPicking(doc, account = null) {
  if (!doc) return null;
  const accountId = accountIdString(doc.baseLinkerAccountId);
  const orderId = orderIdString(doc.orderId);
  if (!accountId || !orderId) return null;
  const order = {
    baseLinkerAccountId: accountId,
    baseLinkerAccountName: String(account?.name || doc.baseLinkerAccountNameSnapshot || ''),
    baseLinkerAccountColor: String(account?.color || ''),
    sourceName: String(doc.sourceNameLastKnown || doc.sourceNameSnapshot || ''),
    orderKey: rowKey(accountId, orderId),
    order_id: Number(orderId),
    shop_order_id: doc.sourceShopOrderId || '',
    external_order_id: doc.sourceExternalOrderId || '',
    order_source: doc.sourceType || '',
    order_source_id: doc.sourceId || '',
    order_status_id: Number.isSafeInteger(Number(doc.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null,
    date_add: Number(doc.sourceDateAdd || 0),
    date_confirmed: Number(doc.sourceDateConfirmed || 0),
    confirmed: true,
    delivery_package_module: doc.sourceDeliveryPackageModule || '',
    delivery_package_nr: doc.sourceDeliveryPackageNr || '',
    products: (Array.isArray(doc.items) ? doc.items : []).map((item) => ({
      order_product_id: item.orderProductId || '', storage: item.storage || '', storage_id: item.storageId || '',
      product_id: item.productId || '', variant_id: item.variantId || '', auction_id: item.auctionId || '',
      sku: item.sku || '', ean: item.ean || '', name: item.name || '', attributes: item.attributes || '', quantity: Number(item.requestedQty || 0),
    })),
  };
  return order;
}

function emitQueueChanged(payload = {}) {
  try { getIO()?.to('baselinker_staff').emit('baselinker_orders_changed', payload); } catch (_) { /* best effort */ }
}

async function ensureBaseLinkerOrderIndexReady() {
  if (!indexReadyPromise) {
    indexReadyPromise = BaseLinkerOrderIndex.createIndexes().catch((error) => {
      indexReadyPromise = null;
      throw error;
    });
  }
  return indexReadyPromise;
}

async function loadIndexState(accountId, scope = null) {
  const id = accountIdString(accountId || scope?.baseLinkerAccountId);
  if (!id) throw appError('baselinker_account_id_required');
  scope = scope || await getQueueScope(id);
  const row = await AppSetting.findOne({ key: stateKey(id) }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    baseLinkerAccountId: id,
    initialized: value.initialized === true && scope.configured && value.scopeKey === scope.scopeKey,
    scopeKey: value.scopeKey || null,
    lastSyncAt: value.lastSyncAt || null,
    orderCount: Number(value.orderCount || 0),
    departureVerificationPending: Number(value.departureVerificationPending || 0),
    trackedReverifyPending: Number(value.trackedReverifyPending || 0),
    journalLastLogId: Number(value.journalLastLogId || 0),
    journalReady: value.journalReady === true,
    lastJournalAt: value.lastJournalAt || null,
    lastError: value.lastError || null,
  };
}

async function saveIndexState(accountId, value) {
  await AppSetting.findOneAndUpdate({ key: stateKey(accountId) }, { $set: { value } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

function fetcherFor(scope) {
  const callApi = makeBaseLinkerAccountCaller(scope.baseLinkerAccountId, { usageStage: 'queue_full_scan' });
  return (options) => fetchBaseLinkerOrders(options, callApi);
}

async function scanIntake(scope, fetchOrders = null) {
  const fetcher = fetchOrders || fetcherFor(scope);
  const result = await fetcher({
    statusId: scope.intakeStatusId,
    includeUnconfirmed: false,
    maxPages: INDEX_MAX_PAGES,
  });
  if (result.truncated) {
    throw appError('baselinker_order_index_truncated', {
      maxOrders: INDEX_MAX_PAGES * 100,
      baseLinkerAccountId: scope.baseLinkerAccountId,
      statusId: scope.intakeStatusId,
    });
  }
  const orders = (result.orders || []).filter((order) => Number(order?.order_status_id) === scope.intakeStatusId);
  cacheIntakeSearch(scope, orders);
  return orders;
}

async function exactOrder(scope, orderId, usageStage = 'queue_exact_verify') {
  const result = await fetchBaseLinkerOrders(
    { orderId, includeUnconfirmed: false, maxPages: 1 },
    makeBaseLinkerAccountCaller(scope.baseLinkerAccountId, { usageStage }),
  );
  return (result.orders || []).find((row) => String(row?.order_id || '') === String(orderId)) || null;
}

function journalLogId(log) {
  const value = Number(log?.log_id ?? log?.id ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function primeJournalCursor(scope) {
  const callApi = makeBaseLinkerAccountCaller(scope.baseLinkerAccountId, { usageStage: 'queue_journal' });
  const payload = await callApi('getJournalList', { logs_types: JOURNAL_LOG_TYPES });
  const logs = Array.isArray(payload?.logs) ? payload.logs : [];
  const lastLogId = logs.reduce((max, log) => Math.max(max, journalLogId(log)), 0);
  return { journalReady: lastLogId > 0, journalLastLogId: lastLogId };
}

async function upsertIndexedOrderProjection(scope, order, { seenAt = new Date(), syncToken = '' } = {}) {
  const accountId = accountIdString(scope?.baseLinkerAccountId);
  const orderId = orderIdString(order?.order_id);
  if (!accountId || !orderId) return false;
  if (classifyUpstreamOrder(order, scope) !== 'intake') {
    await BaseLinkerOrderIndex.deleteOne({ baseLinkerAccountId: accountId, orderId });
    return false;
  }
  const account = await getBaseLinkerAccount(accountId, { lean: true });
  const preview = compactOrder(annotateOrder(order, account, account?.metadataSnapshot?.sources));
  await BaseLinkerOrderIndex.updateOne(
    { baseLinkerAccountId: accountId, orderId },
    { $set: {
      baseLinkerAccountId: accountId,
      orderId,
      orderIdNumeric: Number(orderId),
      orderSortDate: Number(order?.date_confirmed || order?.date_add || 0),
      sourceType: String(order?.order_source || '').trim().toLowerCase(),
      sourceId: String(order?.order_source_id ?? ''),
      preview,
      searchText: orderOperationalSearchText(order),
      ...(syncToken ? { syncToken } : {}),
      seenAt,
    } },
    { upsert: true },
  );
  return true;
}

async function reconcileTrackedOrderStatuses(scope, { limit = TRACKED_REVERIFY_LIMIT, force = false, verifiedAfter = null } = {}) {
  const accountId = String(scope?.baseLinkerAccountId || '').trim();
  if (!accountId || !scope?.configured) return { checked: 0, changed: 0, released: 0, pending: 0 };

  const staleBefore = new Date(Date.now() - TRACKED_REVERIFY_STALE_MS);
  const historyCutoff = new Date(Date.now() - HISTORY_RETENTION_MS);
  const trackedFilter = {
    baseLinkerAccountId: accountId,
    $or: [
      { upstreamReviewRequired: true },
      { workflowStage: { $in: ['processing', 'deferred', 'packed'] } },
      { lastUpstreamChangeAt: { $gte: historyCutoff } },
      { sentAt: { $gte: historyCutoff } },
    ],
  };
  const verifiedBoundary = verifiedAfter instanceof Date && Number.isFinite(verifiedAfter.getTime())
    ? verifiedAfter
    : null;
  if (verifiedBoundary) {
    trackedFilter.$and = [
      { $or: [{ lastUpstreamVerifiedAt: null }, { lastUpstreamVerifiedAt: { $lt: verifiedBoundary } }] },
    ];
  } else if (!force) {
    trackedFilter.$and = [
      { $or: [{ lastUpstreamVerifiedAt: null }, { lastUpstreamVerifiedAt: { $lt: staleBefore } }] },
    ];
  }
  const total = await BaseLinkerPickingOrder.countDocuments(trackedFilter);
  const rows = await BaseLinkerPickingOrder.find(trackedFilter)
    .select('orderId lastUpstreamVerifiedAt')
    .sort({ lastUpstreamVerifiedAt: 1, updatedAt: 1, _id: 1 })
    .limit(Math.max(1, Number(limit) || TRACKED_REVERIFY_LIMIT))
    .lean();

  if (!rows.length) return { checked: 0, changed: 0, released: 0, pending: 0 };
  const orders = [];
  const missingIds = [];
  for (const row of rows) {
    const id = String(row?.orderId || '').trim();
    if (!id) continue;
    const order = await exactOrder(scope, id);
    if (order) orders.push(order); else missingIds.push(id);
  }
  const result = await require('./baseLinkerPicking').reconcilePickingFromUpstreamChanges({
    baseLinkerAccountId: accountId,
    orders,
    removedOrderIds: missingIds,
  });
  const checked = orders.length + missingIds.length;
  return {
    checked,
    changed: Number(result?.changed || 0),
    released: Number(result?.released || 0),
    pending: Math.max(0, total - checked),
  };
}

async function reconcileIndexTransition({ scope, currentOrders, currentIds, previousIds }) {
  const { reconcilePickingFromUpstreamChanges, markPickingOrdersUpstreamUpdated } = require('./baseLinkerPicking');
  const accountId = scope.baseLinkerAccountId;
  const currentById = new Map(currentOrders.map((order) => [String(order.order_id), order]));
  const trackedCurrentRows = await BaseLinkerPickingOrder.find({ baseLinkerAccountId: accountId, orderId: { $in: [...currentIds] } }).select('orderId').lean();
  const trackedCurrentOrders = trackedCurrentRows.map((row) => currentById.get(String(row.orderId))).filter(Boolean);
  if (trackedCurrentOrders.length) await reconcilePickingFromUpstreamChanges({ baseLinkerAccountId: accountId, orders: trackedCurrentOrders, removedOrderIds: [] });

  const departedIds = [...previousIds].filter((id) => !currentIds.has(id));
  if (!departedIds.length) return { departed: 0, restoredIntakeIds: [], verifiedDepartedIds: [], pendingDeparted: 0 };
  const verifyIds = departedIds.slice(0, DEPARTURE_VERIFY_LIMIT);
  const trackedDepartedRows = await BaseLinkerPickingOrder.find({ baseLinkerAccountId: accountId, orderId: { $in: verifyIds } }).select('orderId').lean();
  const trackedDeparted = new Set(trackedDepartedRows.map((row) => String(row.orderId || '')).filter(Boolean));
  const exactOrders = [];
  const missingIds = [];
  for (const id of verifyIds) {
    const order = await exactOrder(scope, id);
    if (order) exactOrders.push(order); else missingIds.push(id);
  }
  await reconcilePickingFromUpstreamChanges({ baseLinkerAccountId: accountId, orders: exactOrders, removedOrderIds: missingIds });
  const restoredIntakeIds = new Set(exactOrders.filter((order) => classifyUpstreamOrder(order, scope) === 'intake').map((order) => String(order.order_id)));
  const effectiveDeparted = verifyIds.filter((id) => !restoredIntakeIds.has(id));
  const untrackedDeparted = effectiveDeparted.filter((id) => !trackedDeparted.has(id));
  if (untrackedDeparted.length) {
    await markPickingOrdersUpstreamUpdated({
      baseLinkerAccountId: accountId,
      orderIds: untrackedDeparted,
      orders: exactOrders,
      knownAdmittedOrderIds: untrackedDeparted,
    });
  }
  return {
    departed: effectiveDeparted.length,
    restoredIntakeIds: [...restoredIntakeIds],
    verifiedDepartedIds: effectiveDeparted,
    pendingDeparted: Math.max(0, departedIds.length - verifyIds.length),
  };
}

async function performIndexSync(scope, opts = {}) {
  const accountId = scope.baseLinkerAccountId;
  const { resetIndex = false, forceReverify = false, trackedVerifiedAfter = null } = opts;
  await ensureBaseLinkerOrderIndexReady();

  const syncToken = crypto.randomUUID();
  const previousRows = await BaseLinkerOrderIndex.find({ baseLinkerAccountId: accountId })
    .select('orderId orderIdNumeric orderSortDate sourceType sourceId')
    .lean();
  // Changing the configured queue statuses defines a new queue universe. Do not
  // reinterpret rows from the old scope as upstream transitions.
  const transitionPreviousRows = resetIndex ? [] : previousRows;
  const previousIds = new Set(transitionPreviousRows.map((row) => String(row.orderId || '')).filter(Boolean));

  const intake = await scanIntake(scope);
  const account = await getBaseLinkerAccount(accountId, { lean: true });
  const rows = intake.map((order) => {
    const annotated = annotateOrder(order, account, account?.metadataSnapshot?.sources);
    return {
      order,
      orderId: orderIdString(order?.order_id),
      orderSortDate: Number(order?.date_confirmed || order?.date_add || 0),
      sourceType: String(order?.order_source || '').trim().toLowerCase(),
      sourceId: String(order?.order_source_id ?? ''),
      preview: compactOrder(annotated),
      searchText: orderOperationalSearchText(order),
    };
  }).filter((row) => row.orderId);
  const currentOrders = rows.map((row) => row.order);
  const currentIds = new Set(rows.map((row) => row.orderId));
  const now = new Date();

  if (rows.length) {
    await BaseLinkerOrderIndex.bulkWrite(rows.map((row) => ({ updateOne: {
      filter: { baseLinkerAccountId: accountId, orderId: row.orderId },
      update: { $set: {
        baseLinkerAccountId: accountId,
        orderId: row.orderId,
        orderIdNumeric: Number(row.orderId),
        orderSortDate: Number(row.orderSortDate || 0),
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        preview: row.preview,
        searchText: row.searchText,
        syncToken,
        seenAt: now,
      } },
      upsert: true,
    } })), { ordered: false });
  }

  try {
    await warmBaseLinkerProductCatalog(
      rows.map((row) => row.preview).filter(Boolean),
      makeBaseLinkerAccountCaller(accountId, { usageStage: 'product_catalog_sync' }),
      { maxRequests: FULL_SCAN_PRODUCT_WARM_REQUESTS },
    );
  } catch (_) { /* product images are supplementary; queue truth must still sync */ }

  const transition = await reconcileIndexTransition({ scope, currentOrders, currentIds, previousIds });
  const trackedReconcile = await reconcileTrackedOrderStatuses(scope, { force: forceReverify, verifiedAfter: trackedVerifiedAfter });
  if (transition.restoredIntakeIds?.length) {
    await BaseLinkerOrderIndex.updateMany(
      { baseLinkerAccountId: accountId, orderId: { $in: transition.restoredIntakeIds } },
      { $set: { syncToken, seenAt: now } },
    );
  }

  // The index is only current Intake membership. On a normal sync, delete only
  // departures we have verified exactly. Unverified departures remain visible
  // and are retried on later syncs rather than being guessed/deleted. A scope
  // reset is an explicit admin configuration change, so old-scope rows can go.
  if (resetIndex) {
    await BaseLinkerOrderIndex.deleteMany({ baseLinkerAccountId: accountId, syncToken: { $ne: syncToken } });
  } else if (transition.verifiedDepartedIds?.length) {
    await BaseLinkerOrderIndex.deleteMany({
      baseLinkerAccountId: accountId,
      orderId: { $in: transition.verifiedDepartedIds },
    });
  }

  let journalState = { journalReady: false, journalLastLogId: 0 };
  try { journalState = await primeJournalCursor(scope); } catch (_) { /* full reconcile remains authoritative */ }

  const orderCount = await BaseLinkerOrderIndex.countDocuments({ baseLinkerAccountId: accountId });
  const lastSyncAt = now.toISOString();
  const added = [...currentIds].filter((id) => !previousIds.has(id)).length;
  const membershipChanged = resetIndex || added > 0 || Number(transition.departed || 0) > 0;
  await saveIndexState(accountId, {
    initialized: true,
    scopeKey: scope.scopeKey,
    lastSyncAt,
    orderCount,
    departureVerificationPending: Number(transition.pendingDeparted || 0),
    trackedReverifyPending: Number(trackedReconcile?.pending || 0),
    journalLastLogId: Number(journalState.journalLastLogId || 0),
    journalReady: journalState.journalReady === true,
    lastJournalAt: journalState.journalReady ? lastSyncAt : null,
    lastError: null,
  });
  await recordAccountSync(accountId, null);
  if (membershipChanged) {
    emitQueueChanged({
      resync: true,
      reason: 'queue_index_membership_changed',
      baseLinkerAccountId: accountId,
      fetchedAt: lastSyncAt,
      added,
      departed: Number(transition.departed || 0),
    });
  }
  return {
    baseLinkerAccountId: accountId,
    initialized: true,
    orderCount,
    lastSyncAt,
    added,
    departed: transition.departed,
    membershipChanged,
    departureVerificationPending: Number(transition.pendingDeparted || 0),
    trackedReverified: Number(trackedReconcile?.checked || 0),
    trackedReconcileChanged: Number(trackedReconcile?.changed || 0),
    trackedReverifyPending: Number(trackedReconcile?.pending || 0),
  };
}

async function syncOneAccount(accountId, { force = false, maxAgeMs = FULL_RECONCILE_MS, trackedVerifiedAfter = null } = {}) {
  const id = accountIdString(accountId);
  const scope = await getQueueScope(id);
  if (scope.accountEnabled !== true) return { baseLinkerAccountId: id, skipped: true, reason: 'account_disabled' };
  if (!scope.configured) return { baseLinkerAccountId: id, skipped: true, reason: 'queue_not_configured' };
  await ensureBaseLinkerOrderIndexReady();
  const state = await loadIndexState(id, scope);
  const ageMs = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Number.POSITIVE_INFINITY;
  if (!force && state.initialized && Number.isFinite(ageMs) && ageMs < maxAgeMs) return { skipped: true, ...state };
  if (syncInFlightByAccount.has(id)) return syncInFlightByAccount.get(id);

  const resetIndex = Boolean(state.scopeKey && state.scopeKey !== scope.scopeKey);
  const promise = withLock(
    `baselinker-order-index-sync:${id}`,
    () => performIndexSync(scope, { resetIndex, forceReverify: force, trackedVerifiedAfter }),
    { ttlMs: 120_000, waitMs: 15_000 },
  ).catch(async (error) => {
    try {
      await saveIndexState(id, {
        initialized: state.initialized,
        scopeKey: state.scopeKey,
        lastSyncAt: state.lastSyncAt,
        orderCount: state.orderCount,
        departureVerificationPending: state.departureVerificationPending,
        trackedReverifyPending: state.trackedReverifyPending,
        journalLastLogId: state.journalLastLogId,
        journalReady: state.journalReady,
        lastJournalAt: state.lastJournalAt,
        lastError: error?.code || error?.message || 'queue_index_sync_failed',
      });
      await recordAccountSync(id, error);
    } catch (_) { /* preserve original */ }
    throw error;
  }).finally(() => syncInFlightByAccount.delete(id));
  syncInFlightByAccount.set(id, promise);
  return promise;
}

async function syncBaseLinkerOrderIndex({ accountId = '', force = false, maxAgeMs = FULL_RECONCILE_MS, trackedVerifiedAfter = null } = {}) {
  await ensureBaseLinkerOrderIndexReady();
  if (accountId) return syncOneAccount(accountId, { force, maxAgeMs, trackedVerifiedAfter });
  const scopes = await getAllQueueScopes({ enabledOnly: true });
  const results = [];
  for (const scope of scopes) {
    try { results.push(await syncOneAccount(scope.baseLinkerAccountId, { force, maxAgeMs, trackedVerifiedAfter })); }
    catch (error) { results.push({ baseLinkerAccountId: scope.baseLinkerAccountId, error: error?.code || error?.message || 'sync_failed' }); }
  }
  return { accounts: results, synced: results.filter((row) => !row.skipped && !row.error).length, failed: results.filter((row) => row.error).length };
}

async function syncBaseLinkerJournalDelta(accountId) {
  const id = accountIdString(accountId);
  if (!id) throw appError('baselinker_account_id_required');
  const scope = await getQueueScope(id);
  if (scope.accountEnabled !== true) return { baseLinkerAccountId: id, skipped: true, reason: 'account_disabled' };
  if (!scope.configured) return { baseLinkerAccountId: id, skipped: true, reason: 'queue_not_configured' };
  const state = await loadIndexState(id, scope);
  if (!state.initialized) return { baseLinkerAccountId: id, skipped: true, reason: 'full_reconcile_required' };
  if (!state.journalReady || !(state.journalLastLogId > 0)) {
    return { baseLinkerAccountId: id, skipped: true, reason: 'journal_not_ready' };
  }

  return withLock(`baselinker-order-journal-sync:${id}`, async () => {
    const freshState = await loadIndexState(id, scope);
    const fromLogId = Number(freshState.journalLastLogId || 0);
    if (!(fromLogId > 0)) return { baseLinkerAccountId: id, skipped: true, reason: 'journal_not_ready' };
    const callApi = makeBaseLinkerAccountCaller(id, { usageStage: 'queue_journal' });
    const payload = await callApi('getJournalList', { last_log_id: fromLogId, logs_types: JOURNAL_LOG_TYPES });
    const logs = (Array.isArray(payload?.logs) ? payload.logs : [])
      .filter((log) => journalLogId(log) > fromLogId)
      .sort((a, b) => journalLogId(a) - journalLogId(b));
    if (!logs.length) {
      await saveIndexState(id, { ...freshState, lastJournalAt: new Date().toISOString(), lastError: null });
      return { baseLinkerAccountId: id, journal: true, changedOrders: 0, cursor: fromLogId };
    }

    const processLogs = [];
    const uniqueOrderIds = new Set();
    for (const log of logs) {
      const orderId = orderIdString(log?.order_id);
      if (orderId && !uniqueOrderIds.has(orderId) && uniqueOrderIds.size >= JOURNAL_MAX_EXACT_PER_TICK) break;
      processLogs.push(log);
      if (orderId) uniqueOrderIds.add(orderId);
    }
    if (!processLogs.length) return { baseLinkerAccountId: id, skipped: true, reason: 'journal_batch_empty' };

    const upstreamOrders = [];
    const missingIds = [];
    for (const orderId of uniqueOrderIds) {
      const order = await exactOrder(scope, orderId, 'queue_journal_exact');
      if (order) upstreamOrders.push(order); else missingIds.push(orderId);
    }

    if (upstreamOrders.length || missingIds.length) {
      await require('./baseLinkerPicking').reconcilePickingFromUpstreamChanges({
        baseLinkerAccountId: id,
        orders: upstreamOrders,
        removedOrderIds: missingIds,
      });
    }

    let upserted = 0;
    let removed = 0;
    const intakePreviews = [];
    for (const order of upstreamOrders) {
      const orderId = orderIdString(order?.order_id);
      if (!orderId) continue;
      if (classifyUpstreamOrder(order, scope) === 'intake') {
        if (await upsertIndexedOrderProjection(scope, order)) upserted += 1;
        const account = await getBaseLinkerAccount(id, { lean: true });
        intakePreviews.push(compactOrder(annotateOrder(order, account, account?.metadataSnapshot?.sources)));
      } else {
        removed += await removeIndexedOrders(id, [orderId]);
      }
    }
    if (missingIds.length) removed += await removeIndexedOrders(id, missingIds);

    if (intakePreviews.length && DELTA_PRODUCT_WARM_REQUESTS > 0) {
      try {
        await warmBaseLinkerProductCatalog(
          intakePreviews,
          makeBaseLinkerAccountCaller(id, { usageStage: 'product_catalog_sync' }),
          { maxRequests: DELTA_PRODUCT_WARM_REQUESTS },
        );
      } catch (_) { /* supplementary only */ }
    }

    const cursor = journalLogId(processLogs[processLogs.length - 1]) || fromLogId;
    const orderCount = await BaseLinkerOrderIndex.countDocuments({ baseLinkerAccountId: id });
    const lastJournalAt = new Date().toISOString();
    await saveIndexState(id, {
      ...freshState,
      orderCount,
      journalReady: true,
      journalLastLogId: cursor,
      lastJournalAt,
      lastError: null,
    });
    if (upserted || removed) {
      emitQueueChanged({
        resync: false,
        reason: 'queue_journal_delta',
        baseLinkerAccountId: id,
        fetchedAt: lastJournalAt,
        changedOrders: uniqueOrderIds.size,
      });
    }
    return {
      baseLinkerAccountId: id,
      journal: true,
      cursor,
      changedOrders: uniqueOrderIds.size,
      upserted,
      removed,
      backlog: processLogs.length < logs.length,
      orderCount,
    };
  }, { ttlMs: 90_000, waitMs: 5_000 });
}

async function removeIndexedOrders(baseLinkerAccountId, orderIds = []) {
  const accountId = accountIdString(baseLinkerAccountId);
  const ids = [...new Set(orderIds.map((id) => orderIdString(id)).filter(Boolean))];
  if (!accountId || !ids.length) return 0;
  const result = await BaseLinkerOrderIndex.deleteMany({ baseLinkerAccountId: accountId, orderId: { $in: ids } });
  return Number(result?.deletedCount || 0);
}

function pickingIsRecentHistory(doc, now = Date.now()) {
  const cutoff = now - HISTORY_RETENTION_MS;
  if (localDisplayStage(doc) === 'sent') return new Date(doc.sentAt || doc.updatedAt || 0).getTime() >= cutoff;
  if (localDisplayStage(doc) === 'cancelled') return new Date(doc.lastUpstreamChangeAt || doc.updatedAt || 0).getTime() >= cutoff;
  return true;
}
function matchesPackedBy(doc, packedBy) { return !packedBy || String(doc?.packedBy || '') === String(packedBy); }

async function liveIntakeOrdersForIds(scope, ids) {
  const wanted = new Set(ids.map(String));
  if (!wanted.size) return new Map();
  const numeric = [...wanted].map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!numeric.length) return new Map();
  const result = await fetchBaseLinkerOrders({ statusId: scope.intakeStatusId, idFrom: Math.min(...numeric), includeUnconfirmed: false, maxPages: 2 }, makeBaseLinkerAccountCaller(scope.baseLinkerAccountId));
  const found = new Map();
  for (const order of result.orders || []) { const id = String(order?.order_id || ''); if (wanted.has(id)) found.set(id, order); if (found.size === wanted.size) break; }
  const trackedRows = found.size ? await BaseLinkerPickingOrder.find({ baseLinkerAccountId: scope.baseLinkerAccountId, orderId: { $in: [...found.keys()] } }).select('orderId').lean() : [];
  if (trackedRows.length) {
    const tracked = new Set(trackedRows.map((row) => String(row.orderId || '')));
    const orders = [...found.entries()].filter(([id]) => tracked.has(id)).map(([, order]) => order);
    if (orders.length) await require('./baseLinkerPicking').reconcilePickingFromUpstreamChanges({ baseLinkerAccountId: scope.baseLinkerAccountId, orders, removedOrderIds: [] });
  }
  const missing = [...wanted].filter((id) => !found.has(id));
  if (missing.length) {
    const exactOrders = []; const missingIds = [];
    for (const id of missing) { const order = await exactOrder(scope, id); if (order) exactOrders.push(order); else missingIds.push(id); }
    const picking = require('./baseLinkerPicking');
    await picking.reconcilePickingFromUpstreamChanges({ baseLinkerAccountId: scope.baseLinkerAccountId, orders: exactOrders, removedOrderIds: missingIds });
    const exactById = new Map(exactOrders.map((order) => [String(order.order_id), order]));
    const trulyDeparted = missing.filter((id) => {
      const order = exactById.get(id);
      if (order && classifyUpstreamOrder(order, scope) === 'intake') { found.set(id, order); return false; }
      return true;
    });
    if (trulyDeparted.length) {
      const trackedRows2 = await BaseLinkerPickingOrder.find({ baseLinkerAccountId: scope.baseLinkerAccountId, orderId: { $in: trulyDeparted } }).select('orderId').lean();
      const tracked = new Set(trackedRows2.map((row) => String(row.orderId || '')));
      const untracked = trulyDeparted.filter((id) => !tracked.has(id));
      if (untracked.length) await picking.markPickingOrdersUpstreamUpdated({ baseLinkerAccountId: scope.baseLinkerAccountId, orderIds: untracked, orders: exactOrders, knownAdmittedOrderIds: untracked });
      await removeIndexedOrders(scope.baseLinkerAccountId, trulyDeparted);
    }
  }
  return found;
}

function compareRows(a, b) {
  const ad = Number(a.orderSortDate || 0), bd = Number(b.orderSortDate || 0);
  if (bd !== ad) return bd - ad;
  const ai = Number(a.orderIdNumeric || a.orderId || 0), bi = Number(b.orderIdNumeric || b.orderId || 0);
  if (bi !== ai) return bi - ai;
  return String(a.baseLinkerAccountId).localeCompare(String(b.baseLinkerAccountId));
}

async function getIndexedOrderPage({ accountId = '', sourceAccountId = '', sourceType = '', sourceId = '', workflowFilter = 'processing', packedBy = '', search = '', page = 1, pageSize: pageSizeInput = 10 } = {}) {
  await ensureBaseLinkerOrderIndexReady();
  // READ PATH CONTRACT: list/search/pagination is Mongo-only. Scheduler/manual
  // sync owns BaseLinker I/O; opening or paging the UI must never consume token budget.
  const safeWorkflow = ['processing', 'deferred', 'packed', 'sent', 'cancelled', 'updated'].includes(String(workflowFilter)) ? String(workflowFilter) : 'processing';
  const requestedPage = normalizePage(page);
  const safePageSize = pageSize(pageSizeInput);
  const normalizedSearch = String(search || '').trim().toLowerCase().slice(0, 160);
  const safePackedBy = safeWorkflow === 'packed' ? String(packedBy || '').trim().slice(0, 120) : '';
  const selectedAccountId = accountIdString(accountId);
  const selectedSourceAccountId = accountIdString(sourceAccountId);
  const selectedSourceType = String(sourceType || '').trim().toLowerCase().slice(0, 80);
  const selectedSourceId = String(sourceId || '').trim().slice(0, 120);
  if (selectedSourceId && (!selectedSourceType || !selectedSourceAccountId)) throw appError('baselinker_source_filter_invalid');
  if (selectedAccountId && selectedSourceAccountId && selectedAccountId !== selectedSourceAccountId) throw appError('baselinker_source_filter_invalid');
  const mongoFilter = selectedAccountId ? { baseLinkerAccountId: selectedAccountId } : {};

  const accounts = await listBaseLinkerAccounts({ includeDisabled: true });
  const accountById = new Map(accounts.map((row) => [row.accountId, row]));
  const [indexRows, pickingDocs] = await Promise.all([
    BaseLinkerOrderIndex.find(mongoFilter).select('baseLinkerAccountId orderId orderIdNumeric orderSortDate sourceType sourceId preview searchText').lean(),
    BaseLinkerPickingOrder.find(mongoFilter).lean(),
  ]);
  indexRows.sort(compareRows);
  const pickingByKey = new Map(pickingDocs.map((doc) => [rowKey(doc.baseLinkerAccountId, doc.orderId), doc]).filter(([key]) => key));
  const indexKeys = indexRows.map((row) => rowKey(row.baseLinkerAccountId, row.orderId)).filter(Boolean);
  const indexSet = new Set(indexKeys);
  const indexByKey = new Map(indexRows.map((row) => [rowKey(row.baseLinkerAccountId, row.orderId), row]).filter(([key]) => key));
  const workflowCounts = { processing: 0, deferred: 0, packed: 0, sent: 0, cancelled: 0, updated: 0 };
  const rowKeysByStage = { processing: [], deferred: [], packed: [], sent: [], cancelled: [], updated: [] };

  for (const key of indexKeys) {
    const row = indexByKey.get(key); const doc = pickingByKey.get(key);
    const account = accountById.get(row.baseLinkerAccountId);
    // Disabled means zero ordinary BaseLinker traffic. Only locally tracked
    // work/history remains visible; untracked index rows are not hydrated.
    if (account?.enabled !== true && !doc) continue;
    const stage = doc ? localDisplayStage(doc) : 'processing';
    if (!rowKeysByStage[stage].includes(key)) rowKeysByStage[stage].push(key);
  }
  for (const doc of pickingDocs) {
    const key = rowKey(doc.baseLinkerAccountId, doc.orderId);
    if (!key || !pickingIsRecentHistory(doc)) continue;
    if (!indexSet.has(key)) { const stage = localDisplayStage(doc); if (!rowKeysByStage[stage].includes(key)) rowKeysByStage[stage].push(key); }
    if (doc.upstreamReviewRequired === true && !rowKeysByStage.updated.includes(key)) rowKeysByStage.updated.push(key);
  }

  if (selectedSourceType || selectedSourceId) {
    const matchesSource = (key) => {
      const row = indexByKey.get(key);
      const doc = pickingByKey.get(key);
      const aid = String(row?.baseLinkerAccountId || doc?.baseLinkerAccountId || '');
      const type = String(row?.sourceType || doc?.sourceType || '').toLowerCase();
      const id = String(row?.sourceId || doc?.sourceId || '');
      if (selectedSourceAccountId && aid !== selectedSourceAccountId) return false;
      if (selectedSourceType && type !== selectedSourceType) return false;
      if (selectedSourceId && id !== selectedSourceId) return false;
      return true;
    };
    for (const stage of Object.keys(rowKeysByStage)) rowKeysByStage[stage] = rowKeysByStage[stage].filter(matchesSource);
  }

  const sortKeys = (keys) => keys.sort((ka, kb) => {
    const ra = indexByKey.get(ka), rb = indexByKey.get(kb);
    const da = ra?.orderSortDate || pickingByKey.get(ka)?.sourceDateConfirmed || pickingByKey.get(ka)?.sourceDateAdd || 0;
    const db = rb?.orderSortDate || pickingByKey.get(kb)?.sourceDateConfirmed || pickingByKey.get(kb)?.sourceDateAdd || 0;
    if (Number(db) !== Number(da)) return Number(db) - Number(da);
    const ao = Number(ra?.orderId || pickingByKey.get(ka)?.orderId || 0), bo = Number(rb?.orderId || pickingByKey.get(kb)?.orderId || 0);
    if (bo !== ao) return bo - ao;
    return ka.localeCompare(kb);
  });
  for (const stage of Object.keys(rowKeysByStage)) sortKeys(rowKeysByStage[stage]);

  if (normalizedSearch) {
    const identitySearchText = (key) => {
      const row = indexByKey.get(key);
      const doc = pickingByKey.get(key);
      const aid = String(row?.baseLinkerAccountId || doc?.baseLinkerAccountId || '');
      const account = accountById.get(aid);
      const type = String(row?.sourceType || doc?.sourceType || '');
      const id = String(row?.sourceId || doc?.sourceId || '');
      const sourceName = resolveSourceName(account?.metadataSnapshot?.sources, type, id);
      return [key, aid, account?.name, type, id, sourceName]
        .filter(Boolean).join(' ').toLowerCase();
    };
    for (const stage of Object.keys(rowKeysByStage)) {
      rowKeysByStage[stage] = rowKeysByStage[stage].filter((key) => {
        const doc = pickingByKey.get(key);
        if (doc && pickingSearchText(doc).includes(normalizedSearch)) return true;
        if (String(indexByKey.get(key)?.searchText || '').includes(normalizedSearch)) return true;
        return identitySearchText(key).includes(normalizedSearch);
      });
    }
  }
  if (safeWorkflow === 'packed' && safePackedBy) rowKeysByStage.packed = rowKeysByStage.packed.filter((key) => matchesPackedBy(pickingByKey.get(key), safePackedBy));
  for (const stage of Object.keys(workflowCounts)) workflowCounts[stage] = rowKeysByStage[stage].length;
  const allKeys = rowKeysByStage[safeWorkflow] || [];
  const total = allKeys.length; const pageCount = Math.max(1, Math.ceil(total / safePageSize)); const actualPage = Math.min(requestedPage, pageCount);
  const selectedKeys = allKeys.slice((actualPage - 1) * safePageSize, actualPage * safePageSize);
  const ordersByKey = new Map();

  for (const key of selectedKeys) {
    const row = indexByKey.get(key);
    if (row?.preview && typeof row.preview === 'object') ordersByKey.set(key, { ...row.preview });
  }
  for (const key of selectedKeys) {
    if (ordersByKey.has(key)) continue;
    const doc = pickingByKey.get(key); if (!doc) continue;
    const order = orderFromPicking(doc, accountById.get(doc.baseLinkerAccountId)); if (order) ordersByKey.set(key, order);
  }

  // Update current source display name on local projections from the API-derived
  // account metadata cache without changing the source identity or original snapshot.
  for (const [key, order] of ordersByKey) {
    const account = accountById.get(order.baseLinkerAccountId);
    if (account && !order.sourceName) order.sourceName = resolveSourceName(account.metadataSnapshot?.sources, order.order_source, order.order_source_id);
  }

  const packedMatch = selectedAccountId ? { baseLinkerAccountId: selectedAccountId } : {};
  const packedByRows = await BaseLinkerPickingOrder.aggregate([
    { $match: { ...packedMatch, packedBy: { $nin: ['', null] }, $or: [{ workflowStage: 'packed' }, { status: 'packed' }] } },
    { $sort: { packedAt: -1, _id: -1 } },
    { $group: { _id: '$packedBy', name: { $first: '$packedByName' }, count: { $sum: 1 }, lastPackedAt: { $first: '$packedAt' } } },
    { $sort: { name: 1, _id: 1 } },
  ]);

  const selectedOrders = selectedKeys.map((key) => ordersByKey.get(key)).filter(Boolean).map(compactOrder);
  const cachedCatalog = await getCachedBaseLinkerProductCatalog(selectedOrders);

  return {
    orders: selectedOrders,
    productCatalog: cachedCatalog.productCatalog,
    productCatalogStats: cachedCatalog.productCatalogStats,
    productCatalogWarnings: cachedCatalog.productCatalogWarnings,
    page: actualPage, pageSize: safePageSize, pageCount, total, workflowCounts,
    packedByOptions: packedByRows.map((row) => ({ value: String(row._id || ''), label: String(row.name || row._id || ''), count: Number(row.count || 0) })).filter((row) => row.value),
    activePackedBy: safePackedBy, activeBaseLinkerAccountId: selectedAccountId, activeSourceAccountId: selectedSourceAccountId, activeSourceType: selectedSourceType, activeSourceId: selectedSourceId,
    historyRetentionDays: HISTORY_RETENTION_DAYS, sentRetentionDays: HISTORY_RETENTION_DAYS, cancelledRetentionDays: HISTORY_RETENTION_DAYS,
  };
}

async function getLocalOrderProjection(baseLinkerAccountId, orderId) {
  const accountId = accountIdString(baseLinkerAccountId); const id = orderIdString(orderId);
  if (!accountId || !id) return null;
  const [doc, account] = await Promise.all([
    BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id }).lean(),
    getBaseLinkerAccount(accountId, { lean: true }).catch(() => null),
  ]);
  return orderFromPicking(doc, account);
}

module.exports = {
  INDEX_STATE_KEY, INDEX_REFRESH_MS, FULL_RECONCILE_MS, INDEX_MAX_PAGES, DEPARTURE_VERIFY_LIMIT, TRACKED_REVERIFY_LIMIT, TRACKED_REVERIFY_STALE_MS, VISIBLE_TRACKED_REVERIFY_LIMIT, SAFE_INDEX_PAGES_PER_SCAN,
  ensureBaseLinkerOrderIndexReady, loadIndexState, syncBaseLinkerOrderIndex, syncBaseLinkerJournalDelta, syncOneAccount, reconcileTrackedOrderStatuses,
  removeIndexedOrders, getIndexedOrderPage, orderFromPicking, scanIntake, getLocalOrderProjection,
};
