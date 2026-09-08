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
// One backend poll owns BaseLinker queue discovery for every connected worker.
// Browser list/search/pagination never talks to BaseLinker directly.
const INDEX_REFRESH_MS = Math.min(5 * 60_000, Math.max(15_000, Number(process.env.BASELINKER_QUEUE_REFRESH_MS) || 30_000));
// setInterval is anchored to scheduler start, while lastSyncAt is written after
// the upstream scan. Keep a small tolerance so a normal 30s tick does not turn
// into an accidental 60s cadence merely because the previous scan took time.
const POLL_FRESHNESS_MS = Math.max(10_000, INDEX_REFRESH_MS - 5_000);
const FULL_SCAN_PRODUCT_WARM_REQUESTS = Math.min(10, Math.max(0, Number(process.env.BASELINKER_FULL_SCAN_PRODUCT_WARM_REQUESTS) || 5));
const SCANS_PER_MINUTE = Math.max(1, Math.ceil(60_000 / INDEX_REFRESH_MS));
// Reserve part of every token budget for product enrichment, metadata checks
// and explicit operator mutations. Increasing queue size safely therefore
// requires a slower poll cadence rather than bypassing the BaseLinker token limit.
const SYNC_REQUEST_RESERVE_PER_MINUTE = Math.min(40, Math.max(20, Number(process.env.BASELINKER_QUEUE_REQUEST_RESERVE) || 30));
const SAFE_INDEX_PAGES_PER_SCAN = Math.max(1, Math.floor((BASELINKER_REQUEST_BUDGET_PER_MINUTE - SYNC_REQUEST_RESERVE_PER_MINUTE) / SCANS_PER_MINUTE));
const REQUESTED_INDEX_MAX_PAGES = Math.max(1, Number(process.env.BASELINKER_QUEUE_MAX_PAGES) || SAFE_INDEX_PAGES_PER_SCAN);
const INDEX_MAX_PAGES = Math.min(60, SAFE_INDEX_PAGES_PER_SCAN, REQUESTED_INDEX_MAX_PAGES);
const TRACKED_REVERIFY_LIMIT = Math.min(10, Math.max(1, Number(process.env.BASELINKER_TRACKED_REVERIFY_LIMIT) || 4));
const TRACKED_REVERIFY_STALE_MS = Math.max(15_000, Number(process.env.BASELINKER_TRACKED_REVERIFY_MS) || INDEX_REFRESH_MS);
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
  // Packed remains an internal/audit state for backwards compatibility, but
  // it is no longer a user-facing shelf. Any old Packed rows are surfaced in
  // Processing so an operator can finish them with the single Send action.
  if (String(doc?.workflowStage || '') === 'packed' || String(doc?.status || '') === 'packed') return 'processing';
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
    delivery_method: doc.sourceDeliveryMethod || '',
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
  const trackedFilter = {
    baseLinkerAccountId: accountId,
    $or: [
      { upstreamReviewRequired: true },
      { workflowStage: { $in: ['processing', 'deferred', 'packed'] } },
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
  // Backfill photos for recent tracked Allegro orders that have no Base catalog
  // product_id. This exact auction_id path performs zero BaseLinker API calls;
  // it only populates our image cache for historical Sent/Deferred rows.
  const offerOnlyOrders = orders.map((order) => ({
    ...order,
    products: (Array.isArray(order?.products) ? order.products : []).filter((product) => (
      String(order?.order_source || '').trim().toLowerCase() === 'allegro'
      && !String(product?.product_id || '').trim()
      && /^\d{5,30}$/.test(String(product?.auction_id || '').trim())
    )),
  })).filter((order) => order.products.length);
  if (offerOnlyOrders.length) {
    try {
      await warmBaseLinkerProductCatalog(offerOnlyOrders, async () => {
        throw appError('baselinker_catalog_request_budget_exhausted');
      }, { maxRequests: 0 });
    } catch (_) { /* supplementary only */ }
  }
  const checked = orders.length + missingIds.length;
  return {
    checked,
    changed: Number(result?.changed || 0),
    released: Number(result?.released || 0),
    pending: Math.max(0, total - checked),
  };
}

async function reconcileIndexTransition({ scope, currentOrders, currentIds, previousIds }) {
  const { reconcilePickingFromUpstreamChanges } = require('./baseLinkerPicking');
  const accountId = scope.baseLinkerAccountId;
  const currentById = new Map(currentOrders.map((order) => [String(order.order_id), order]));
  const trackedCurrentRows = await BaseLinkerPickingOrder.find({ baseLinkerAccountId: accountId, orderId: { $in: [...currentIds] } }).select('orderId').lean();
  const trackedCurrentOrders = trackedCurrentRows.map((row) => currentById.get(String(row.orderId))).filter(Boolean);
  if (trackedCurrentOrders.length) {
    // The periodic getOrders(Intake) payload is already authoritative for every
    // tracked order that is still actionable, so reconcile it with zero extra API calls.
    await reconcilePickingFromUpstreamChanges({ baseLinkerAccountId: accountId, orders: trackedCurrentOrders, removedOrderIds: [] });
  }

  const departedIds = [...previousIds].filter((id) => !currentIds.has(id));
  if (!departedIds.length) return { departed: 0, removedOrderIds: [], pendingDeparted: 0 };

  // Absence from the complete configured Intake scan proves only one thing:
  // the order is no longer actionable in this queue. Do not burn an exact
  // getOrders request merely to classify Sent/Cancelled/other here. Tracked
  // work is moved to explicit upstream review; an operator/critical action can
  // exact-verify later if the precise terminal status matters.
  const trackedDepartedRows = await BaseLinkerPickingOrder.find({
    baseLinkerAccountId: accountId,
    orderId: { $in: departedIds },
  }).select('orderId').lean();
  const trackedDepartedIds = trackedDepartedRows.map((row) => String(row.orderId || '')).filter(Boolean);
  if (trackedDepartedIds.length) {
    await reconcilePickingFromUpstreamChanges({
      baseLinkerAccountId: accountId,
      orders: [],
      removedOrderIds: trackedDepartedIds,
    });
  }

  return {
    departed: departedIds.length,
    removedOrderIds: departedIds,
    pendingDeparted: 0,
  };
}

async function performIndexSync(scope, opts = {}) {
  const accountId = scope.baseLinkerAccountId;
  const { resetIndex = false, trackedVerifiedAfter = null } = opts;
  await ensureBaseLinkerOrderIndexReady();

  const syncToken = crypto.randomUUID();
  const previousRows = await BaseLinkerOrderIndex.find({ baseLinkerAccountId: accountId })
    .select('orderId orderIdNumeric orderSortDate sourceType sourceId preview')
    .lean();
  // Changing the configured queue statuses defines a new queue universe. Do not
  // reinterpret rows from the old scope as upstream transitions.
  const transitionPreviousRows = resetIndex ? [] : previousRows;
  const previousIds = new Set(transitionPreviousRows.map((row) => String(row.orderId || '')).filter(Boolean));
  const previousPreviewById = new Map(transitionPreviousRows
    .map((row) => [String(row.orderId || ''), row.preview && typeof row.preview === 'object' ? row.preview : null])
    .filter(([id]) => id));

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
  const shouldReverifyTracked = trackedVerifiedAfter instanceof Date && Number.isFinite(trackedVerifiedAfter.getTime());
  const trackedReconcile = shouldReverifyTracked
    ? await reconcileTrackedOrderStatuses(scope, { verifiedAfter: trackedVerifiedAfter })
    : { checked: 0, changed: 0, released: 0, pending: 0 };
  // The local index mirrors only the configured Intake status. The complete
  // status scan itself is authoritative for membership, so rows absent from
  // the new scan are removed without a second BaseLinker request.
  if (resetIndex) {
    await BaseLinkerOrderIndex.deleteMany({ baseLinkerAccountId: accountId, syncToken: { $ne: syncToken } });
  } else if (transition.removedOrderIds?.length) {
    await BaseLinkerOrderIndex.deleteMany({
      baseLinkerAccountId: accountId,
      orderId: { $in: transition.removedOrderIds },
    });
  }

  const orderCount = await BaseLinkerOrderIndex.countDocuments({ baseLinkerAccountId: accountId });
  const lastSyncAt = now.toISOString();
  const addedIds = [...currentIds].filter((id) => !previousIds.has(id));
  const added = addedIds.length;
  const membershipChanged = resetIndex || added > 0 || Number(transition.departed || 0) > 0;
  const changedOrders = rows
    .filter((row) => {
      const previous = previousPreviewById.get(row.orderId);
      if (!previous) return true;
      return JSON.stringify(previous) !== JSON.stringify(row.preview);
    })
    .map((row) => row.preview);
  await saveIndexState(accountId, {
    initialized: true,
    scopeKey: scope.scopeKey,
    lastSyncAt,
    orderCount,
    departureVerificationPending: Number(transition.pendingDeparted || 0),
    trackedReverifyPending: Number(trackedReconcile?.pending || 0),
    lastError: null,
  });
  await recordAccountSync(accountId, null);
  if (membershipChanged || changedOrders.length) {
    emitQueueChanged({
      resync: membershipChanged,
      reason: membershipChanged ? 'queue_poll_membership_changed' : 'queue_poll_data_changed',
      baseLinkerAccountId: accountId,
      fetchedAt: lastSyncAt,
      added,
      departed: Number(transition.departed || 0),
      orders: membershipChanged ? [] : changedOrders,
      removedOrderIds: transition.removedOrderIds || [],
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
    changedOrders: changedOrders.length,
    departureVerificationPending: Number(transition.pendingDeparted || 0),
    trackedReverified: Number(trackedReconcile?.checked || 0),
    trackedReconcileChanged: Number(trackedReconcile?.changed || 0),
    trackedReverifyPending: Number(trackedReconcile?.pending || 0),
  };
}

async function syncOneAccount(accountId, { force = false, maxAgeMs = POLL_FRESHNESS_MS, trackedVerifiedAfter = null } = {}) {
  const id = accountIdString(accountId);
  const scope = await getQueueScope(id);
  if (scope.accountEnabled !== true) return { baseLinkerAccountId: id, skipped: true, reason: 'account_disabled' };
  if (!scope.configured) return { baseLinkerAccountId: id, skipped: true, reason: 'queue_not_configured' };
  await ensureBaseLinkerOrderIndexReady();

  const state = await loadIndexState(id, scope);
  const ageMs = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Number.POSITIVE_INFINITY;
  if (!force && state.initialized && Number.isFinite(ageMs) && ageMs < maxAgeMs) return { skipped: true, ...state };
  if (syncInFlightByAccount.has(id)) return syncInFlightByAccount.get(id);

  const promise = withLock(
    `baselinker-order-index-sync:${id}`,
    async () => {
      // Distributed lock can be acquired after another process has just synced.
      // Re-read state here so that second process returns without another API call.
      const freshState = await loadIndexState(id, scope);
      const freshAgeMs = freshState.lastSyncAt ? Date.now() - Date.parse(freshState.lastSyncAt) : Number.POSITIVE_INFINITY;
      if (!force && freshState.initialized && Number.isFinite(freshAgeMs) && freshAgeMs < maxAgeMs) {
        return { skipped: true, reason: 'queue_poll_fresh_after_lock', ...freshState };
      }
      const resetIndex = Boolean(freshState.scopeKey && freshState.scopeKey !== scope.scopeKey);
      return performIndexSync(scope, { resetIndex, trackedVerifiedAfter });
    },
    { ttlMs: Math.max(120_000, INDEX_REFRESH_MS * 3), waitMs: 15_000 },
  ).catch(async (error) => {
    try {
      const latest = await loadIndexState(id, scope).catch(() => state);
      await saveIndexState(id, {
        initialized: latest.initialized,
        scopeKey: latest.scopeKey,
        lastSyncAt: latest.lastSyncAt,
        orderCount: latest.orderCount,
        departureVerificationPending: latest.departureVerificationPending,
        trackedReverifyPending: latest.trackedReverifyPending,
        lastError: error?.code || error?.message || 'queue_index_sync_failed',
      });
      await recordAccountSync(id, error);
    } catch (_) { /* preserve original */ }
    throw error;
  }).finally(() => syncInFlightByAccount.delete(id));
  syncInFlightByAccount.set(id, promise);
  return promise;
}

async function syncBaseLinkerOrderIndex({ accountId = '', force = false, maxAgeMs = POLL_FRESHNESS_MS, trackedVerifiedAfter = null } = {}) {
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

function compareRows(a, b) {
  const ad = Number(a.orderSortDate || 0), bd = Number(b.orderSortDate || 0);
  if (bd !== ad) return bd - ad;
  const ai = Number(a.orderIdNumeric || a.orderId || 0), bi = Number(b.orderIdNumeric || b.orderId || 0);
  if (bi !== ai) return bi - ai;
  return String(a.baseLinkerAccountId).localeCompare(String(b.baseLinkerAccountId));
}

async function getIndexedOrderPage({ accountId = '', sourceAccountId = '', sourceType = '', sourceId = '', workflowFilter = 'processing', packedBy = '', sentBy = '', search = '', page = 1, pageSize: pageSizeInput = 10 } = {}) {
  await ensureBaseLinkerOrderIndexReady();
  // READ PATH CONTRACT: list/search/pagination is Mongo-only. Scheduler/manual
  // sync owns BaseLinker I/O; opening or paging the UI must never consume token budget.
  const safeWorkflow = ['processing', 'deferred', 'sent', 'cancelled', 'updated'].includes(String(workflowFilter)) ? String(workflowFilter) : 'processing';
  const requestedPage = normalizePage(page);
  const safePageSize = pageSize(pageSizeInput);
  const normalizedSearch = String(search || '').trim().toLowerCase().slice(0, 160);
  const safePackedBy = safeWorkflow === 'sent' ? String(packedBy || '').trim().slice(0, 120) : '';
  const safeSentBy = safeWorkflow === 'sent' ? String(sentBy || '').trim().slice(0, 120) : '';
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
  const workflowCounts = { processing: 0, deferred: 0, sent: 0, cancelled: 0, updated: 0 };
  const rowKeysByStage = { processing: [], deferred: [], sent: [], cancelled: [], updated: [] };

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
  if (safeWorkflow === 'sent' && safePackedBy) rowKeysByStage.sent = rowKeysByStage.sent.filter((key) => matchesPackedBy(pickingByKey.get(key), safePackedBy));
  if (safeWorkflow === 'sent' && safeSentBy) rowKeysByStage.sent = rowKeysByStage.sent.filter((key) => String(pickingByKey.get(key)?.sentBy || '') === safeSentBy);
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
    { $match: { ...packedMatch, packedBy: { $nin: ['', null] }, $or: [{ workflowStage: 'sent' }, { status: 'sent' }] } },
    { $sort: { packedAt: -1, _id: -1 } },
    { $group: { _id: '$packedBy', name: { $first: '$packedByName' }, count: { $sum: 1 }, lastPackedAt: { $first: '$packedAt' } } },
    { $sort: { name: 1, _id: 1 } },
  ]);
  const sentByRows = await BaseLinkerPickingOrder.aggregate([
    { $match: { ...packedMatch, sentBy: { $nin: ['', null] }, $or: [{ workflowStage: 'sent' }, { status: 'sent' }] } },
    { $sort: { sentAt: -1, _id: -1 } },
    { $group: { _id: '$sentBy', name: { $first: '$sentByName' }, count: { $sum: 1 }, lastSentAt: { $first: '$sentAt' } } },
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
    sentByOptions: sentByRows.map((row) => ({ value: String(row._id || ''), label: String(row.name || row._id || ''), count: Number(row.count || 0) })).filter((row) => row.value),
    activePackedBy: safePackedBy, activeSentBy: safeSentBy, activeBaseLinkerAccountId: selectedAccountId, activeSourceAccountId: selectedSourceAccountId, activeSourceType: selectedSourceType, activeSourceId: selectedSourceId,
    historyRetentionDays: HISTORY_RETENTION_DAYS, sentRetentionDays: HISTORY_RETENTION_DAYS, cancelledRetentionDays: HISTORY_RETENTION_DAYS,
  };
}

async function getLocalOrderProjection(baseLinkerAccountId, orderId) {
  const accountId = accountIdString(baseLinkerAccountId); const id = orderIdString(orderId);
  if (!accountId || !id) return null;
  const [indexRow, doc, account] = await Promise.all([
    BaseLinkerOrderIndex.findOne({ baseLinkerAccountId: accountId, orderId: id }).select('preview').lean(),
    BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id }).lean(),
    getBaseLinkerAccount(accountId, { lean: true }).catch(() => null),
  ]);
  if (indexRow?.preview && typeof indexRow.preview === 'object') return compactOrder(indexRow.preview);
  return orderFromPicking(doc, account);
}

module.exports = {
  INDEX_STATE_KEY, INDEX_REFRESH_MS, POLL_FRESHNESS_MS, INDEX_MAX_PAGES, TRACKED_REVERIFY_LIMIT, TRACKED_REVERIFY_STALE_MS, SAFE_INDEX_PAGES_PER_SCAN,
  ensureBaseLinkerOrderIndexReady, loadIndexState, syncBaseLinkerOrderIndex, syncOneAccount, reconcileTrackedOrderStatuses,
  removeIndexedOrders, getIndexedOrderPage, orderFromPicking, scanIntake, getLocalOrderProjection,
};
