'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const AppSetting = require('../models/AppSetting');
const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { compactOrder } = require('./baseLinkerPublicDto');
const {
  getQueueScope,
  classifyUpstreamOrder,
  orderInSentScope,
  orderInCancelledScope,
  HISTORY_LOOKBACK_DAYS,
} = require('./baseLinkerQueueScope');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');

const INDEX_STATE_KEY = 'baselinker.orderIndex.v1';
const INDEX_REFRESH_MS = Math.min(5 * 60_000, Math.max(15_000, Number(process.env.BASELINKER_QUEUE_REFRESH_MS) || 30_000));
// Terminal status scans must walk every order in those BaseLinker statuses
// because the API cannot filter by date_in_status. Keep that expensive scan
// separate from the fast Intake membership refresh.
const TERMINAL_INDEX_REFRESH_MS = Math.min(
  60 * 60_000,
  Math.max(5 * 60_000, Number(process.env.BASELINKER_TERMINAL_REFRESH_MS) || (5 * 60_000)),
);
const INDEX_MAX_PAGES = Math.min(90, Math.max(1, Number(process.env.BASELINKER_QUEUE_MAX_PAGES) || 90));
const PAGE_SIZE_VALUES = new Set([10, 20, 50]);
const HISTORY_RETENTION_MS = HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
let indexReadyPromise = null;
let syncInFlight = null;

function normalizePage(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function pageSize(value) {
  const n = Number(value);
  return PAGE_SIZE_VALUES.has(n) ? n : 10;
}

function orderIdString(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : '';
}

function localDisplayStage(doc) {
  const disposition = String(doc?.upstreamDisposition || '');
  if (disposition === 'cancelled') return 'cancelled';
  if (disposition === 'sent' || String(doc?.status || '') === 'sent' || String(doc?.workflowStage || '') === 'sent') return 'sent';
  if (String(doc?.workflowStage || '') === 'packed' || String(doc?.status || '') === 'packed') return 'packed';
  if (String(doc?.workflowStage || '') === 'deferred' || ['paused', 'problem', 'ready_to_pack_with_issue'].includes(String(doc?.status || ''))) return 'deferred';
  return 'processing';
}

function pickingSearchText(doc) {
  return [
    doc?.orderId,
    doc?.sourceShopOrderId,
    doc?.sourceExternalOrderId,
    ...(Array.isArray(doc?.items) ? doc.items.flatMap((item) => [
      item?.name,
      item?.sku,
      item?.ean,
      item?.productId,
      item?.variantId,
      item?.orderProductId,
    ]) : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function orderSearchText(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  return [
    order?.order_id,
    order?.shop_order_id,
    order?.external_order_id,
    order?.email,
    order?.phone,
    order?.delivery_fullname,
    order?.delivery_company,
    ...products.flatMap((item) => [item?.name, item?.sku, item?.ean, item?.product_id, item?.variant_id, item?.order_product_id]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function orderFromPicking(doc) {
  if (!doc) return null;
  const orderId = orderIdString(doc.orderId);
  if (!orderId) return null;
  return {
    order_id: Number(orderId),
    shop_order_id: doc.sourceShopOrderId || '',
    external_order_id: doc.sourceExternalOrderId || '',
    order_status_id: Number.isSafeInteger(Number(doc.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null,
    date_add: Number(doc.sourceDateAdd || 0),
    date_confirmed: Number(doc.sourceDateConfirmed || 0),
    confirmed: true,
    delivery_package_module: doc.sourceDeliveryPackageModule || '',
    delivery_package_nr: doc.sourceDeliveryPackageNr || '',
    products: (Array.isArray(doc.items) ? doc.items : []).map((item) => ({
      order_product_id: item.orderProductId || '',
      storage: item.storage || '',
      storage_id: item.storageId || '',
      product_id: item.productId || '',
      variant_id: item.variantId || '',
      auction_id: item.auctionId || '',
      sku: item.sku || '',
      ean: item.ean || '',
      name: item.name || '',
      attributes: item.attributes || '',
      quantity: Number(item.requestedQty || 0),
    })),
  };
}

function emitQueueChanged(payload = {}) {
  try {
    const io = getIO();
    if (!io) return;
    io.to('baselinker_staff').emit('baselinker_orders_changed', payload);
  } catch (_) {
    // Socket delivery is best-effort; the DB/index transition is authoritative.
  }
}

async function dropLegacyMirrorCollections() {
  // The old full-order mirror and immutable raw snapshots are retired. Drop
  // their Mongo collections directly so a deployment does not keep stale full
  // BaseLinker payloads around merely because old model files once existed.
  const names = new Set((await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
  for (const name of ['baselinkerordercaches', 'baselinkerordersnapshots']) {
    if (!names.has(name)) continue;
    try { await mongoose.connection.db.collection(name).drop(); } catch (error) {
      if (error?.codeName !== 'NamespaceNotFound' && error?.code !== 26) throw error;
    }
  }
  await AppSetting.deleteMany({ key: { $in: ['baselinker.orderCache.v2', 'baselinker.journal.v1'] } });
}

async function ensureBaseLinkerOrderIndexReady() {
  if (!indexReadyPromise) {
    indexReadyPromise = (async () => {
      await BaseLinkerOrderIndex.syncIndexes();
      await dropLegacyMirrorCollections();
      return true;
    })().catch((error) => {
      indexReadyPromise = null;
      throw error;
    });
  }
  return indexReadyPromise;
}

async function loadIndexState(scope = null) {
  scope = scope || await getQueueScope();
  const row = await AppSetting.findOne({ key: INDEX_STATE_KEY }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    initialized: value.initialized === true && scope.configured && value.scopeKey === scope.scopeKey,
    scopeKey: value.scopeKey || null,
    lastSyncAt: value.lastSyncAt || null,
    lastTerminalAttemptAt: value.lastTerminalAttemptAt || null,
    lastTerminalSyncAt: value.lastTerminalSyncAt || null,
    lastTerminalError: value.lastTerminalError || null,
    orderCount: Number(value.orderCount || 0),
    lastError: value.lastError || null,
  };
}

async function saveIndexState(value) {
  await AppSetting.findOneAndUpdate(
    { key: INDEX_STATE_KEY },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function scanIntake(scope, fetchOrders = fetchBaseLinkerOrders) {
  const result = await fetchOrders({
    statusId: scope.intakeStatusId,
    includeUnconfirmed: true,
    maxPages: INDEX_MAX_PAGES,
  });
  if (result.truncated) {
    throw appError('baselinker_order_index_truncated', { maxOrders: INDEX_MAX_PAGES * 100 });
  }
  return (result.orders || []).filter((order) => Number(order?.order_status_id) === scope.intakeStatusId);
}

async function scanTerminalHistory(scope, disposition, fetchOrders = fetchBaseLinkerOrders) {
  const sent = disposition === 'sent';
  const statusId = sent ? scope.sentStatusId : scope.cancelledStatusId;
  const inScope = sent ? orderInSentScope : orderInCancelledScope;
  const result = await fetchOrders({
    statusId,
    includeUnconfirmed: true,
    maxPages: INDEX_MAX_PAGES,
  });
  if (result.truncated) {
    throw appError('baselinker_order_index_truncated', { maxOrders: INDEX_MAX_PAGES * 100 });
  }
  return (result.orders || []).filter((order) => inScope(order, scope));
}

async function scanQueue(scope, fetchOrders = fetchBaseLinkerOrders) {
  // BaseLinker cannot filter getOrders by date_in_status. Scan each configured
  // status with the documented id_from cursor, then apply the 14-day terminal
  // boundary locally. Keep the calls sequential to avoid an API burst.
  const intake = await scanIntake(scope, fetchOrders);
  const sent = await scanTerminalHistory(scope, 'sent', fetchOrders);
  const cancelled = await scanTerminalHistory(scope, 'cancelled', fetchOrders);
  const byId = new Map();
  for (const [disposition, orders] of [['intake', intake], ['sent', sent], ['cancelled', cancelled]]) {
    for (const order of orders) {
      const orderId = orderIdString(order?.order_id);
      if (!orderId) continue;
      byId.set(orderId, {
        order,
        orderId,
        disposition,
        dateInStatus: disposition === 'intake' ? 0 : Number(order?.date_in_status || 0),
      });
    }
  }
  return { intake, sent, cancelled, rows: [...byId.values()] };
}

async function exactOrder(orderId) {
  const result = await fetchBaseLinkerOrders({ orderId, includeUnconfirmed: true, maxPages: 1 });
  return (result.orders || []).find((row) => String(row?.order_id || '') === String(orderId)) || null;
}

async function reconcileIndexTransition({ scope, currentOrders, currentIds, previousIds, previousIntakeIds }) {
  const { reconcilePickingFromUpstreamChanges, markPickingOrdersUpstreamUpdated } = require('./baseLinkerPicking');
  const currentById = new Map(currentOrders.map((order) => [String(order.order_id), order]));

  // Existing local work can be reconciled from the transient Intake scan with
  // zero extra BaseLinker requests. This catches product/status restoration
  // without persisting the upstream payload anywhere.
  const trackedCurrentIds = await BaseLinkerPickingOrder.find({ orderId: { $in: [...currentIds] } }).select('orderId').lean();
  const trackedCurrentOrders = trackedCurrentIds.map((row) => currentById.get(String(row.orderId))).filter(Boolean);
  if (trackedCurrentOrders.length) await reconcilePickingFromUpstreamChanges({ orders: trackedCurrentOrders, removedOrderIds: [] });

  const departedIds = [...previousIds].filter((id) => !currentIds.has(id));
  if (!departedIds.length) return { departed: 0, restoredIntakeIds: [] };

  const trackedDepartedRows = await BaseLinkerPickingOrder.find({ orderId: { $in: departedIds } }).select('orderId').lean();
  const trackedDeparted = new Set(trackedDepartedRows.map((row) => String(row.orderId || '')).filter(Boolean));
  const exactOrders = [];
  const missingIds = [];
  for (const id of departedIds) {
    const order = await exactOrder(id);
    if (order) exactOrders.push(order);
    else missingIds.push(id);
  }

  // First update already-existing PickingOrder rows. Only orders that were
  // admitted into Intake but never claimed need a new local review/cancelled
  // record materialized here; existing rows must not be revision-bumped twice.
  await reconcilePickingFromUpstreamChanges({ orders: exactOrders, removedOrderIds: missingIds });
  const restoredIntakeIds = new Set(exactOrders.filter((order) => classifyUpstreamOrder(order, scope) === 'intake').map((order) => String(order.order_id)));
  const effectiveDeparted = departedIds.filter((id) => !restoredIntakeIds.has(id));
  const untrackedDeparted = effectiveDeparted.filter((id) => !trackedDeparted.has(id));
  if (untrackedDeparted.length) {
    await markPickingOrdersUpstreamUpdated({
      orderIds: untrackedDeparted,
      orders: exactOrders,
      // Only a row that actually departed Intake was admitted to warehouse
      // work. An expired terminal-history row must not be re-materialized as a
      // fresh Updated/Cancelled local PickingOrder.
      knownAdmittedOrderIds: untrackedDeparted.filter((id) => previousIntakeIds.has(id)),
    });
  }
  return { departed: effectiveDeparted.length, restoredIntakeIds: [...restoredIntakeIds] };
}

async function performIndexSync(scope, {
  resetIndex = false,
  refreshTerminal = false,
  lastTerminalAttemptAt = null,
  lastTerminalSyncAt = null,
  lastTerminalError = null,
} = {}) {
  await ensureBaseLinkerOrderIndexReady();
  const syncToken = crypto.randomUUID();
  const previousRows = await BaseLinkerOrderIndex.find({})
    .select('orderId orderIdNumeric upstreamDisposition dateInStatus')
    .lean();
  // A settings revision defines a new scope. Keep old rows in Mongo until the
  // replacement scan succeeds (fail closed), but never exact-read the entire
  // old scope as if hundreds of orders had individually departed Intake.
  const transitionPreviousRows = resetIndex ? [] : previousRows;
  const previousIds = new Set(transitionPreviousRows.map((row) => String(row.orderId || '')).filter(Boolean));
  const previousIntakeIds = new Set(transitionPreviousRows
    .filter((row) => !row.upstreamDisposition || row.upstreamDisposition === 'intake')
    .map((row) => String(row.orderId || ''))
    .filter(Boolean));
  let queue;
  if (refreshTerminal) {
    queue = await scanQueue(scope);
  } else {
    const intake = await scanIntake(scope);
    const rows = intake.map((order) => ({
      order,
      orderId: orderIdString(order?.order_id),
      disposition: 'intake',
      dateInStatus: 0,
    })).filter((row) => row.orderId);
    for (const row of previousRows) {
      const disposition = String(row.upstreamDisposition || 'intake');
      if (!['sent', 'cancelled'].includes(disposition)) continue;
      const orderId = orderIdString(row.orderId);
      if (!orderId) continue;
      rows.push({
        order: null,
        orderId,
        disposition,
        dateInStatus: Number(row.dateInStatus || 0),
      });
    }
    queue = { intake, sent: [], cancelled: [], rows };
  }
  const currentOrders = queue.rows.map((row) => row.order);
  const currentIds = new Set(queue.rows.map((row) => row.orderId));
  const now = new Date();

  const fetchedRows = queue.rows.filter((row) => row.order);
  if (fetchedRows.length) {
    await BaseLinkerOrderIndex.bulkWrite(fetchedRows.map((row) => ({
      updateOne: {
        filter: { orderId: row.orderId },
        update: {
          $set: {
            orderId: row.orderId,
            orderIdNumeric: Number(row.orderId),
            upstreamDisposition: row.disposition,
            dateInStatus: row.dateInStatus,
            syncToken,
            seenAt: now,
          },
        },
        upsert: true,
      },
    })), { ordered: false });
  }

  // Reconcile before sweep. If any exact read fails, the stale ID rows remain
  // and the whole sync fails closed instead of silently dropping warehouse work.
  const transition = await reconcileIndexTransition({
    scope,
    currentOrders: currentOrders.filter(Boolean),
    currentIds,
    previousIds,
    previousIntakeIds,
  });
  if (transition.restoredIntakeIds?.length) {
    await BaseLinkerOrderIndex.updateMany(
      { orderId: { $in: transition.restoredIntakeIds } },
      { $set: { syncToken, seenAt: now } },
    );
  }
  // Intake is refreshed every fast tick. Terminal rows are swept only after an
  // actual terminal scan; otherwise their previous syncToken remains untouched
  // and hundreds of unchanged history rows do not get rewritten every 30s.
  await BaseLinkerOrderIndex.deleteMany({
    syncToken: { $ne: syncToken },
    $or: [{ upstreamDisposition: 'intake' }, { upstreamDisposition: { $exists: false } }],
  });
  if (refreshTerminal) {
    await BaseLinkerOrderIndex.deleteMany({
      syncToken: { $ne: syncToken },
      upstreamDisposition: { $in: ['sent', 'cancelled'] },
    });
  }
  const orderCount = await BaseLinkerOrderIndex.countDocuments({});
  const lastSyncAt = now.toISOString();
  const added = [...currentIds].filter((id) => !previousIds.has(id)).length;
  const membershipChanged = resetIndex || added > 0 || Number(transition.departed || 0) > 0;
  const nextLastTerminalSyncAt = refreshTerminal ? lastSyncAt : lastTerminalSyncAt;
  const nextLastTerminalError = refreshTerminal ? null : lastTerminalError;
  await saveIndexState({
    initialized: true,
    scopeKey: scope.scopeKey,
    lastSyncAt,
    lastTerminalAttemptAt,
    lastTerminalSyncAt: nextLastTerminalSyncAt,
    lastTerminalError: nextLastTerminalError,
    orderCount,
    lastError: null,
  });
  // A stable queue refresh must be silent. Picking/product changes emit their
  // own exact-order socket event; queue membership changes are the only reason
  // to invalidate the paged list globally.
  if (membershipChanged) {
    emitQueueChanged({ resync: true, reason: 'queue_index_membership_changed', fetchedAt: lastSyncAt, added, departed: Number(transition.departed || 0) });
  }
  return {
    initialized: true,
    orderCount,
    lastSyncAt,
    lastTerminalAttemptAt,
    lastTerminalSyncAt: nextLastTerminalSyncAt,
    lastTerminalError: nextLastTerminalError,
    terminalRefreshed: refreshTerminal,
    added,
    departed: transition.departed,
    membershipChanged,
  };
}

async function syncBaseLinkerOrderIndex({ force = false, maxAgeMs = INDEX_REFRESH_MS } = {}) {
  const scope = await getQueueScope();
  if (!scope.configured) throw appError('baselinker_queue_not_configured');
  await ensureBaseLinkerOrderIndexReady();
  const state = await loadIndexState(scope);
  const ageMs = state.lastSyncAt ? Date.now() - Date.parse(state.lastSyncAt) : Number.POSITIVE_INFINITY;
  if (!force && state.initialized && Number.isFinite(ageMs) && ageMs < maxAgeMs) {
    return { skipped: true, ...state };
  }

  if (syncInFlight) return syncInFlight;
  const resetIndex = Boolean(state.scopeKey && state.scopeKey !== scope.scopeKey);
  const nowMs = Date.now();
  const lastTerminalAttemptMs = state.lastTerminalAttemptAt ? Date.parse(state.lastTerminalAttemptAt) : 0;
  const terminalAttemptAgeMs = lastTerminalAttemptMs > 0 ? nowMs - lastTerminalAttemptMs : Number.POSITIVE_INFINITY;
  const refreshTerminal = resetIndex || !state.initialized
    || !Number.isFinite(terminalAttemptAgeMs) || terminalAttemptAgeMs >= TERMINAL_INDEX_REFRESH_MS;
  const terminalAttemptAt = refreshTerminal ? new Date(nowMs).toISOString() : state.lastTerminalAttemptAt;
  syncInFlight = withLock('baselinker-order-index-sync', () => performIndexSync(scope, {
    resetIndex,
    refreshTerminal,
    lastTerminalAttemptAt: terminalAttemptAt,
    lastTerminalSyncAt: state.lastTerminalSyncAt,
    lastTerminalError: state.lastTerminalError,
  }), { ttlMs: 120_000, waitMs: 15_000 })
    .catch(async (error) => {
      try {
        await saveIndexState({
          initialized: state.initialized,
          // Preserve the last successfully synchronized scope. If the first
          // sync after a settings change fails, the next attempt must still
          // reset/rebuild the index instead of accepting the new scope key.
          scopeKey: state.scopeKey,
          lastSyncAt: state.lastSyncAt,
          lastTerminalAttemptAt: terminalAttemptAt,
          lastTerminalSyncAt: state.lastTerminalSyncAt,
          lastTerminalError: refreshTerminal
            ? (error?.code || error?.message || 'terminal_queue_index_sync_failed')
            : state.lastTerminalError,
          orderCount: state.orderCount,
          lastError: error?.code || error?.message || 'queue_index_sync_failed',
        });
      } catch (_) { /* preserve upstream error */ }
      throw error;
    })
    .finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function removeIndexedOrders(orderIds = []) {
  const ids = [...new Set(orderIds.map((id) => orderIdString(id)).filter(Boolean))];
  if (!ids.length) return 0;
  const result = await BaseLinkerOrderIndex.deleteMany({ orderId: { $in: ids } });
  return Number(result?.deletedCount || 0);
}

function pickingIsRecentHistory(doc, now = Date.now()) {
  const cutoff = now - HISTORY_RETENTION_MS;
  if (localDisplayStage(doc) === 'sent') {
    return new Date(doc.sentAt || doc.updatedAt || 0).getTime() >= cutoff;
  }
  if (localDisplayStage(doc) === 'cancelled') {
    return new Date(doc.lastUpstreamChangeAt || doc.updatedAt || 0).getTime() >= cutoff;
  }
  return true;
}

function matchesPackedBy(doc, packedBy) {
  return !packedBy || String(doc?.packedBy || '') === String(packedBy);
}

async function liveIntakeOrdersForIds(scope, ids) {
  const wanted = new Set(ids.map(String));
  if (!wanted.size) return new Map();
  const numeric = [...wanted].map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!numeric.length) return new Map();

  const result = await fetchBaseLinkerOrders({
    statusId: scope.intakeStatusId,
    idFrom: Math.min(...numeric),
    includeUnconfirmed: true,
    maxPages: 2,
  });
  const found = new Map();
  for (const order of result.orders || []) {
    const id = String(order?.order_id || '');
    if (wanted.has(id)) found.set(id, order);
    if (found.size === wanted.size) break;
  }

  // For already-tracked rows, the transient live page payload is also our
  // immediate upstream-change detector. Compare it with PickingOrder now so a
  // quantity/product change is visible on page refresh without persisting the
  // BaseLinker order or waiting for the background index interval.
  const trackedFoundRows = found.size
    ? await BaseLinkerPickingOrder.find({ orderId: { $in: [...found.keys()] } }).select('orderId').lean()
    : [];
  if (trackedFoundRows.length) {
    const trackedIds = new Set(trackedFoundRows.map((row) => String(row.orderId || '')).filter(Boolean));
    const trackedOrders = [...found.entries()].filter(([id]) => trackedIds.has(id)).map(([, order]) => order);
    if (trackedOrders.length) {
      const { reconcilePickingFromUpstreamChanges } = require('./baseLinkerPicking');
      await reconcilePickingFromUpstreamChanges({ orders: trackedOrders, removedOrderIds: [] });
    }
  }

  // A status transition can race the page read after the index sync. Exact-read
  // only the missing page rows, reconcile them, and remove stale index IDs.
  const missing = [...wanted].filter((id) => !found.has(id));
  if (missing.length) {
    const exactOrders = [];
    const missingIds = [];
    for (const id of missing) {
      const order = await exactOrder(id);
      if (order) exactOrders.push(order);
      else missingIds.push(id);
    }
    const { reconcilePickingFromUpstreamChanges, markPickingOrdersUpstreamUpdated } = require('./baseLinkerPicking');
    await reconcilePickingFromUpstreamChanges({ orders: exactOrders, removedOrderIds: missingIds });
    const exactById = new Map(exactOrders.map((order) => [String(order.order_id), order]));
    const trulyDeparted = missing.filter((id) => {
      const order = exactById.get(id);
      if (order && classifyUpstreamOrder(order, scope) === 'intake') {
        found.set(id, order);
        return false;
      }
      return true;
    });
    if (trulyDeparted.length) {
      const trackedRows = await BaseLinkerPickingOrder.find({ orderId: { $in: trulyDeparted } }).select('orderId').lean();
      const tracked = new Set(trackedRows.map((row) => String(row.orderId || '')));
      const untracked = trulyDeparted.filter((id) => !tracked.has(id));
      if (untracked.length) await markPickingOrdersUpstreamUpdated({ orderIds: untracked, orders: exactOrders, knownAdmittedOrderIds: untracked });
      await removeIndexedOrders(trulyDeparted);
    }
  }
  return found;
}

async function liveTerminalOrdersForIds(scope, ids, indexById) {
  const found = new Map();
  const groups = new Map();
  for (const id of ids) {
    const disposition = String(indexById.get(id)?.upstreamDisposition || '');
    if (!['sent', 'cancelled'].includes(disposition)) continue;
    if (!groups.has(disposition)) groups.set(disposition, []);
    groups.get(disposition).push(String(id));
  }
  // One selected history page belongs to one status and contains at most 50
  // adjacent indexed ids. A single status/id_from page therefore replaces up
  // to 50 exact getOrders calls.
  for (const [disposition, groupIds] of groups) {
    const wanted = new Set(groupIds);
    const numeric = groupIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
    if (!numeric.length) continue;
    const result = await fetchBaseLinkerOrders({
      statusId: disposition === 'sent' ? scope.sentStatusId : scope.cancelledStatusId,
      idFrom: Math.min(...numeric),
      includeUnconfirmed: true,
      maxPages: 1,
    });
    for (const order of result.orders || []) {
      const id = String(order?.order_id || '');
      if (wanted.has(id)) found.set(id, order);
    }
  }
  return found;
}

async function getIndexedOrderPage({ workflowFilter = 'processing', packedBy = '', search = '', page = 1, pageSize: pageSizeInput = 10 } = {}) {
  const scope = await getQueueScope();
  await syncBaseLinkerOrderIndex({ maxAgeMs: INDEX_REFRESH_MS });
  const safeWorkflow = ['processing', 'deferred', 'packed', 'sent', 'cancelled', 'updated'].includes(String(workflowFilter))
    ? String(workflowFilter)
    : 'processing';
  const requestedPage = normalizePage(page);
  const safePageSize = pageSize(pageSizeInput);
  const normalizedSearch = String(search || '').trim().toLowerCase().slice(0, 160);
  const safePackedBy = safeWorkflow === 'packed' ? String(packedBy || '').trim().slice(0, 120) : '';

  const [indexRows, pickingDocs] = await Promise.all([
    BaseLinkerOrderIndex.find({}).select('orderId orderIdNumeric upstreamDisposition dateInStatus').sort({ orderIdNumeric: -1 }).lean(),
    BaseLinkerPickingOrder.find({}).lean(),
  ]);
  const pickingById = new Map(pickingDocs.map((doc) => [String(doc.orderId || ''), doc]).filter(([id]) => id));
  const indexIds = indexRows.map((row) => String(row.orderId || '')).filter(Boolean);
  const indexSet = new Set(indexIds);
  const indexById = new Map(indexRows.map((row) => [String(row.orderId || ''), row]).filter(([id]) => id));

  const workflowCounts = { processing: 0, deferred: 0, packed: 0, sent: 0, cancelled: 0, updated: 0 };
  const rowIdsByStage = { processing: [], deferred: [], packed: [], sent: [], cancelled: [], updated: [] };

  // Intake IDs are fresh/new queue membership. An existing local document keeps
  // its own workflow shelf; an unclaimed Intake ID is Processing.
  for (const id of indexIds) {
    const doc = pickingById.get(id);
    const indexedDisposition = String(indexById.get(id)?.upstreamDisposition || 'intake');
    const stage = ['sent', 'cancelled'].includes(indexedDisposition)
      ? indexedDisposition
      : (doc ? localDisplayStage(doc) : 'processing');
    if (!rowIdsByStage[stage].includes(id)) rowIdsByStage[stage].push(id);
  }

  // Local work survives independently of upstream Intake membership.
  for (const doc of pickingDocs) {
    const id = String(doc.orderId || '');
    if (!id || !pickingIsRecentHistory(doc)) continue;
    if (!indexSet.has(id)) {
      const stage = localDisplayStage(doc);
      if (!rowIdsByStage[stage].includes(id)) rowIdsByStage[stage].push(id);
    }
    if (doc.upstreamReviewRequired === true && !rowIdsByStage.updated.includes(id)) rowIdsByStage.updated.push(id);
  }

  // Stable newest-first order: BaseLinker order_id for fresh queue rows, and the
  // same order_id fallback for local rows. We never need full upstream payload
  // persisted merely to sort the queue.
  for (const key of Object.keys(rowIdsByStage)) {
    rowIdsByStage[key].sort((a, b) => Number(b) - Number(a));
  }

  let liveSearchOrders = null;
  if (normalizedSearch) {
    // Product/customer search over untouched Intake orders is an explicit live
    // BaseLinker read. The full response is used only in this request and never
    // written to Mongo. Local PickingOrder rows are searched from our own data.
    // Searching terminal history must never trigger a full status walk on each
    // keystroke. Untouched terminal rows can be found by order id; locally
    // tracked rows retain their product metadata for text search.
    const live = await scanIntake(scope);
    liveSearchOrders = new Map(live.map((order) => [String(order.order_id), order]));
    for (const stage of Object.keys(rowIdsByStage)) {
      rowIdsByStage[stage] = rowIdsByStage[stage].filter((id) => {
        const doc = pickingById.get(id);
        if (doc && pickingSearchText(doc).includes(normalizedSearch)) return true;
        const order = liveSearchOrders.get(id);
        return order ? orderSearchText(order).includes(normalizedSearch) : id.includes(normalizedSearch);
      });
    }
  }

  if (safeWorkflow === 'packed' && safePackedBy) {
    rowIdsByStage.packed = rowIdsByStage.packed.filter((id) => matchesPackedBy(pickingById.get(id), safePackedBy));
  }

  for (const stage of Object.keys(workflowCounts)) workflowCounts[stage] = rowIdsByStage[stage].length;
  const allIds = rowIdsByStage[safeWorkflow] || [];
  const total = allIds.length;
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const actualPage = Math.min(requestedPage, pageCount);
  const selectedIds = allIds.slice((actualPage - 1) * safePageSize, actualPage * safePageSize);

  const ordersById = new Map();
  const selectedIntakeIds = selectedIds.filter((id) => indexSet.has(id)
    && String(indexById.get(id)?.upstreamDisposition || 'intake') === 'intake');
  const selectedTerminalIds = selectedIds.filter((id) => indexSet.has(id)
    && ['sent', 'cancelled'].includes(String(indexById.get(id)?.upstreamDisposition || ''))
    && !pickingById.has(id));
  if (liveSearchOrders) {
    const trackedOrders = [];
    for (const id of selectedIntakeIds) {
      const order = liveSearchOrders.get(id);
      if (!order) continue;
      ordersById.set(id, order);
      if (pickingById.has(id)) trackedOrders.push(order);
    }
    if (trackedOrders.length) {
      const { reconcilePickingFromUpstreamChanges } = require('./baseLinkerPicking');
      await reconcilePickingFromUpstreamChanges({ orders: trackedOrders, removedOrderIds: [] });
    }
  } else {
    const live = await liveIntakeOrdersForIds(scope, selectedIntakeIds);
    for (const [id, order] of live) ordersById.set(id, order);
    const terminal = await liveTerminalOrdersForIds(scope, selectedTerminalIds, indexById);
    for (const [id, order] of terminal) ordersById.set(id, order);
  }

  for (const id of selectedIds) {
    if (ordersById.has(id)) continue;
    const doc = pickingById.get(id);
    const order = orderFromPicking(doc);
    if (order) ordersById.set(id, order);
  }

  const packedByRows = await BaseLinkerPickingOrder.aggregate([
    { $match: { packedBy: { $nin: ['', null] }, $or: [{ workflowStage: 'packed' }, { status: 'packed' }] } },
    { $sort: { packedAt: -1, _id: -1 } },
    { $group: { _id: '$packedBy', name: { $first: '$packedByName' }, count: { $sum: 1 }, lastPackedAt: { $first: '$packedAt' } } },
    { $sort: { name: 1, _id: 1 } },
  ]);

  return {
    orders: selectedIds.map((id) => ordersById.get(id)).filter(Boolean).map(compactOrder),
    page: actualPage,
    pageSize: safePageSize,
    pageCount,
    total,
    workflowCounts,
    packedByOptions: packedByRows.map((row) => ({ value: String(row._id || ''), label: String(row.name || row._id || ''), count: Number(row.count || 0) })).filter((row) => row.value),
    activePackedBy: safePackedBy,
    historyRetentionDays: HISTORY_LOOKBACK_DAYS,
    sentRetentionDays: HISTORY_LOOKBACK_DAYS,
    cancelledRetentionDays: HISTORY_LOOKBACK_DAYS,
  };
}


async function getLocalOrderProjection(orderId) {
  const id = orderIdString(orderId);
  if (!id) return null;
  const doc = await BaseLinkerPickingOrder.findOne({ orderId: id }).lean();
  return orderFromPicking(doc);
}

module.exports = {
  INDEX_STATE_KEY,
  INDEX_REFRESH_MS,
  TERMINAL_INDEX_REFRESH_MS,
  INDEX_MAX_PAGES,
  ensureBaseLinkerOrderIndexReady,
  loadIndexState,
  syncBaseLinkerOrderIndex,
  removeIndexedOrders,
  getIndexedOrderPage,
  orderFromPicking,
  scanIntake,
  scanTerminalHistory,
  scanQueue,
  getLocalOrderProjection,
};
