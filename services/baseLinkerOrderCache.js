'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const BaseLinkerOrderCache = require('../models/BaseLinkerOrderCache');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { compactOrder } = require('./baseLinkerPublicDto');
const { baseLinkerOrderSnapshotHash, recordBaseLinkerOrderSnapshots } = require('./baseLinkerOrderSnapshots');
const {
  getBaseLinkerAccountScope,
  scopedSettingKey,
  scopedLockKey,
} = require('./baseLinkerAccount');
const {
  getQueueScope,
  orderInIntakeScope,
  orderInSentScope,
  orderInQueueScope,
} = require('./baseLinkerQueueScope');

const CACHE_STATE_KEY = 'baselinker.orderCache.v2';
// Intake has no date window, so the scan must be allowed to finish. This is
// still bounded to ONE BaseLinker status, never the whole account.
const CACHE_BOOTSTRAP_MAX_PAGES = Math.min(90, Math.max(1, Number(process.env.BASELINKER_QUEUE_MAX_PAGES) || 90));
const CACHE_REFRESH_MS = 5 * 60_000;
const PAGE_SIZE_VALUES = new Set([10, 20, 50]);
const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let indexPromise = null;

function safePositiveInt(value, fallback = 1) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizePageSize(value) {
  const n = Number(value);
  return PAGE_SIZE_VALUES.has(n) ? n : 10;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function orderSearchText(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  return [
    order?.order_id,
    order?.shop_order_id,
    order?.external_order_id,
    ...products.flatMap((product) => [
      product?.name,
      product?.sku,
      product?.ean,
      product?.product_id,
      product?.variant_id,
      product?.auction_id,
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function cacheRowForOrder(order, syncToken = '', accountScope = getBaseLinkerAccountScope()) {
  const orderId = String(order?.order_id ?? '').trim();
  if (!orderId) return null;
  return {
    accountScope,
    orderId,
    orderIdNumeric: Number(order?.order_id || 0) || 0,
    orderStatusId: Number.isInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
    sortAt: Number(order?.date_confirmed || order?.date_add || 0) || 0,
    searchText: orderSearchText(order),
    order,
    snapshotHash: baseLinkerOrderSnapshotHash(order),
    syncToken: String(syncToken || ''),
    upstreamCachedAt: new Date(),
  };
}

async function ensureIndexes() {
  if (!indexPromise) {
    indexPromise = (async () => {
      // One-time cleanup of the retired logical-order compatibility field.
      await BaseLinkerOrderCache.collection.updateMany(
        { accountScope: getBaseLinkerAccountScope() },
        { $unset: { groupKey: '' } },
      );
      return BaseLinkerOrderCache.syncIndexes();
    })().catch((error) => {
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

async function upsertCachedOrders(orders, { syncToken = '', source = 'cache_refresh' } = {}) {
  const accountScope = getBaseLinkerAccountScope();
  const rows = (orders || []).map((order) => cacheRowForOrder(order, syncToken, accountScope)).filter(Boolean);
  if (!rows.length) return 0;
  await ensureIndexes();
  // Preserve the exact upstream payload before the mutable latest-cache row is overwritten.
  await recordBaseLinkerOrderSnapshots(orders, { source });
  const operations = rows.map((row) => ({
    updateOne: {
      filter: { accountScope, orderId: row.orderId },
      update: { $set: row },
      upsert: true,
    },
  }));
  const result = await BaseLinkerOrderCache.bulkWrite(operations, { ordered: false });
  return Number(result?.upsertedCount || 0) + Number(result?.modifiedCount || 0) + Number(result?.matchedCount || 0);
}

async function removeCachedOrders(orderIds) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!ids.length) return 0;
  const result = await BaseLinkerOrderCache.deleteMany({ accountScope: getBaseLinkerAccountScope(), orderId: { $in: ids } });
  return Number(result?.deletedCount || 0);
}

function retainedPickingFilter(now = new Date()) {
  const sentCutoff = new Date(now.getTime() - SENT_RETENTION_MS);
  return {
    $and: [
      { accountScope: getBaseLinkerAccountScope() },
      // Cancelled/Sent are upstream terminal facts. Keep them after they leave
      // intake only while somebody still has to acknowledge the change, or
      // while a local Sent record is inside the same 30-day history window.
      {
        $or: [
          { upstreamDisposition: { $in: ['', 'intake'] } },
          { upstreamReviewRequired: true },
          { sentAt: { $gte: sentCutoff } },
        ],
      },
      {
        $or: [
          { workflowStage: { $in: ['processing', 'deferred', 'packed'] } },
          { status: { $in: ['in_progress', 'paused', 'problem', 'ready_to_pack', 'ready_to_pack_with_issue', 'packed'] } },
          { sentAt: { $gte: sentCutoff } },
          { upstreamReviewRequired: true },
        ],
      },
    ],
  };
}

async function retainedPickingOrderIds({ touchedOrderIds = null } = {}) {
  const filter = retainedPickingFilter();
  if (Array.isArray(touchedOrderIds) && touchedOrderIds.length) {
    const ids = [...new Set(touchedOrderIds.map(String))];
    filter.$and.push({ orderId: { $in: ids } });
  }
  const docs = await BaseLinkerPickingOrder.find(filter).select('orderId').lean();
  return new Set(docs.map((doc) => String(doc.orderId || '')).filter(Boolean));
}

async function cacheState(scope = null) {
  scope = scope || await getQueueScope();
  const row = await AppSetting.findOne({ key: scopedSettingKey(CACHE_STATE_KEY, scope.accountScope) }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    initialized: value.initialized === true && scope.configured && value.scopeKey === scope.scopeKey,
    scopeKey: value.scopeKey || null,
    lastFullSyncAt: value.lastFullSyncAt || null,
    orderCount: Number(value.orderCount || 0),
  };
}

async function saveCacheState(value, accountScope = getBaseLinkerAccountScope()) {
  await AppSetting.findOneAndUpdate(
    { key: scopedSettingKey(CACHE_STATE_KEY, accountScope) },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function scanConfiguredScopes(scope) {
  const intake = await fetchBaseLinkerOrders({
    statusId: scope.intakeStatusId,
    // The selected Intake status is the operator's source of truth. BaseLinker
    // can keep an order in that status with confirmed=false, and it must not
    // disappear merely because date_confirmed is still empty.
    includeUnconfirmed: true,
    maxPages: CACHE_BOOTSTRAP_MAX_PAGES,
  });
  if (intake.truncated) {
    throw appError('baselinker_order_cache_bootstrap_truncated', {
      scope: 'intake',
      maxOrders: CACHE_BOOTSTRAP_MAX_PAGES * 100,
    });
  }

  const sent = await fetchBaseLinkerOrders({
    statusId: scope.sentStatusId,
    dateConfirmedFrom: scope.sentDateConfirmedFrom,
    includeUnconfirmed: false,
    maxPages: CACHE_BOOTSTRAP_MAX_PAGES,
  });
  if (sent.truncated) {
    throw appError('baselinker_order_cache_bootstrap_truncated', {
      scope: 'sent_30_days',
      maxOrders: CACHE_BOOTSTRAP_MAX_PAGES * 100,
    });
  }

  const byId = new Map();
  for (const order of intake.orders || []) if (orderInIntakeScope(order, scope)) byId.set(String(order.order_id), order);
  for (const order of sent.orders || []) if (orderInSentScope(order, scope)) byId.set(String(order.order_id), order);
  return [...byId.values()];
}

async function bootstrapCacheUnlocked() {
  const scope = await getQueueScope();
  if (!scope.configured) throw appError('baselinker_queue_not_configured');
  await ensureIndexes();
  const syncToken = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const orders = await scanConfiguredScopes(scope);

  if ((await getQueueScope()).scopeKey !== scope.scopeKey) throw appError('baselinker_queue_warming');
  // Reconcile only present orders. Leaving the intake queue is not deletion and
  // must not erase saved warehouse work.
  const { reconcilePickingFromUpstreamChanges, ensurePickingIndexesReady } = require('./baseLinkerPicking');
  await ensurePickingIndexesReady();
  await reconcilePickingFromUpstreamChanges({ orders });
  await upsertCachedOrders(orders, { syncToken, source: 'full_sync' });

  const retainedIds = [...await retainedPickingOrderIds()];
  const sweep = { accountScope: scope.accountScope, syncToken: { $ne: syncToken } };
  if (retainedIds.length) sweep.orderId = { $nin: retainedIds };
  await BaseLinkerOrderCache.deleteMany(sweep);

  const orderCount = await BaseLinkerOrderCache.countDocuments({ accountScope: scope.accountScope });
  const lastFullSyncAt = new Date().toISOString();
  await saveCacheState({ initialized: true, scopeKey: scope.scopeKey, lastFullSyncAt, orderCount }, scope.accountScope);
  return { initialized: true, lastFullSyncAt, orderCount };
}

async function ensureBaseLinkerOrderCacheReady(scope = null) {
  scope = scope || await getQueueScope();
  if (!scope.configured) throw appError('baselinker_queue_not_configured');
  const current = await cacheState(scope);
  if (current.initialized) {
    const actualCount = await BaseLinkerOrderCache.countDocuments({ accountScope: scope.accountScope });
    if (actualCount > 0 || current.orderCount === 0) return { ...current, orderCount: actualCount };
  }
  throw appError('baselinker_queue_warming');
}

// Scheduler only: HTTP reads never trigger or wait for an upstream scan.
async function syncBaseLinkerOrderCache({ force = false } = {}) {
  const scope = await getQueueScope();
  if (!scope.configured) return { skipped: true, reason: 'queue_not_configured' };
  return withLock(scopedLockKey('baselinker-order-cache-sync', scope.accountScope), async () => {
    const current = await cacheState(scope);
    if (!force && current.initialized && Date.now() - Date.parse(current.lastFullSyncAt) < CACHE_REFRESH_MS) {
      const count = await BaseLinkerOrderCache.countDocuments({ accountScope: scope.accountScope });
      if (count > 0 || current.orderCount === 0) return { skipped: true, reason: 'fresh' };
    }
    return bootstrapCacheUnlocked();
  }, { ttlMs: 15 * 60_000, waitMs: 0 });
}


async function getKnownCachedOrderIds(orderIds = []) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await BaseLinkerOrderCache.find({
    accountScope: getBaseLinkerAccountScope(),
    orderId: { $in: ids },
  }).select('orderId').lean();
  return rows.map((row) => String(row.orderId || '')).filter(Boolean);
}

async function refreshBaseLinkerOrderCache({ orders = [], removedOrderIds = [] } = {}) {
  const initialScope = await getQueueScope();
  if (!initialScope.configured) return;
  return withLock(scopedLockKey('baselinker-order-cache-sync', initialScope.accountScope), async () => {
    const scope = await getQueueScope();
    const touchedIds = [...new Set([
      ...(orders || []).map((order) => String(order?.order_id || '')),
      ...(removedOrderIds || []).map(String),
    ].filter(Boolean))];
    const retainedIds = await retainedPickingOrderIds({ touchedOrderIds: touchedIds });
    const toUpsert = (orders || []).filter((order) => (
      orderInQueueScope(order, scope) || retainedIds.has(String(order?.order_id || ''))
    ));
    await upsertCachedOrders(toUpsert, { source: 'journal_refresh' });

    const removable = [
      ...(orders || []).filter((order) => !orderInQueueScope(order, scope)).map((order) => String(order?.order_id || '')),
      ...(removedOrderIds || []).map(String),
    ].filter((id) => id && !retainedIds.has(id));
    await removeCachedOrders(removable);
  }, { ttlMs: 15 * 60_000, waitMs: 0 });
}

function localDisplayStageExpression() {
  return {
    $cond: [
      { $in: ['$localWorkflowStage', ['processing', 'deferred', 'packed', 'sent']] },
      '$localWorkflowStage',
      {
        $switch: {
          branches: [
            { case: { $in: ['$localStatus', ['paused', 'problem', 'ready_to_pack_with_issue']] }, then: 'deferred' },
            { case: { $eq: ['$localStatus', 'packed'] }, then: 'packed' },
            { case: { $eq: ['$localStatus', 'sent'] }, then: 'sent' },
          ],
          default: 'processing',
        },
      },
    ],
  };
}

async function getCachedOrderPage({ workflowFilter = 'processing', packedBy = '', search = '', page = 1, pageSize = 10 } = {}) {
  const scope = await getQueueScope();
  await ensureBaseLinkerOrderCacheReady(scope);

  const safePage = safePositiveInt(page, 1);
  const safePageSize = normalizePageSize(pageSize);
  const safeWorkflow = ['processing', 'deferred', 'packed', 'sent', 'updated'].includes(String(workflowFilter))
    ? String(workflowFilter)
    : 'processing';
  const safePackedBy = String(packedBy || '').trim().slice(0, 120);
  const match = { accountScope: scope.accountScope };
  const normalizedSearch = String(search || '').trim().toLowerCase().slice(0, 160);
  if (normalizedSearch) match.searchText = { $regex: escapeRegex(normalizedSearch), $options: 'i' };

  const pickingCollection = BaseLinkerPickingOrder.collection.name;
  const skip = (safePage - 1) * safePageSize;
  const localSentCutoff = new Date(Date.now() - SENT_RETENTION_MS);
  const upstreamSentCutoffSeconds = scope.sentDateConfirmedFrom;

  const pageMatch = safeWorkflow === 'updated'
    ? { updatedEligible: true }
    : {
      normalEligible: true,
      displayStage: safeWorkflow,
      ...(safeWorkflow === 'packed' && safePackedBy ? { localPackedBy: safePackedBy } : {}),
    };

  const pipeline = [
    { $match: match },
    { $sort: { sortAt: -1, orderIdNumeric: -1 } },
    {
      $group: {
        _id: '$orderId',
        sortAt: { $first: '$sortAt' },
        orderIdNumeric: { $first: '$orderIdNumeric' },
        intakeEligible: { $max: { $cond: [{ $eq: ['$orderStatusId', scope.intakeStatusId] }, 1, 0] } },
        upstreamSent: { $max: { $cond: [{ $eq: ['$orderStatusId', scope.sentStatusId] }, 1, 0] } },
        upstreamSentRecent: {
          $max: {
            $cond: [
              { $and: [{ $eq: ['$orderStatusId', scope.sentStatusId] }, { $gte: ['$sortAt', upstreamSentCutoffSeconds] }] },
              1,
              0,
            ],
          },
        },
        upstreamCancelled: { $max: { $cond: [{ $eq: ['$orderStatusId', scope.cancelledStatusId] }, 1, 0] } },
      },
    },
    {
      $lookup: {
        from: pickingCollection,
        let: { cacheOrderId: '$_id', accountScope: scope.accountScope },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$accountScope', '$$accountScope'] },
                  { $eq: ['$orderId', '$$cacheOrderId'] },
                ],
              },
            },
          },
          { $project: { _id: 1, status: 1, workflowStage: 1, orderId: 1, packedBy: 1, packedByName: 1, packedAt: 1, sentAt: 1, updatedAt: 1, upstreamReviewRequired: 1, upstreamDisposition: 1 } },
        ],
        as: 'pickingDocs',
      },
    },
    {
      $addFields: {
        hasPickingDoc: { $eq: [{ $size: '$pickingDocs' }, 1] },
        localStatus: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.status', 0] }, 'new'] },
        localWorkflowStage: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.workflowStage', 0] }, ''] },
        localPackedBy: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.packedBy', 0] }, ''] },
        localPackedByName: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.packedByName', 0] }, ''] },
        localPackedAt: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.packedAt', 0] }, null] },
        localSentAt: { $ifNull: [{ $arrayElemAt: ['$pickingDocs.sentAt', 0] }, { $arrayElemAt: ['$pickingDocs.updatedAt', 0] }] },
        localUpstreamReviewRequired: { $eq: [{ $arrayElemAt: ['$pickingDocs.upstreamReviewRequired', 0] }, true] },
      },
    },
    { $addFields: { localDisplayStage: localDisplayStageExpression() } },
    {
      $addFields: {
        displayStage: {
          $cond: [
            { $eq: ['$upstreamSentRecent', 1] },
            'sent',
            '$localDisplayStage',
          ],
        },
        updatedEligible: {
          $and: [
            { $eq: ['$localUpstreamReviewRequired', true] },
            { $or: [{ $ne: ['$upstreamSent', 1] }, { $eq: ['$upstreamSentRecent', 1] }] },
          ],
        },
      },
    },
    {
      $addFields: {
        normalEligible: {
          $switch: {
            branches: [
              // Cancellation is visible only in Updated until the operator
              // presses "Прийнято". It must never fall back into Processing.
              { case: { $eq: ['$upstreamCancelled', 1] }, then: false },
              // BaseLinker Sent is a read-only 30-day history shelf regardless
              // of stale local stage.
              { case: { $eq: ['$upstreamSent', 1] }, then: { $eq: ['$upstreamSentRecent', 1] } },
              // Fresh unclaimed intake order.
              { case: { $eq: ['$hasPickingDoc', false] }, then: { $eq: ['$intakeEligible', 1] } },
            ],
            default: {
              $or: [
                { $ne: ['$displayStage', 'sent'] },
                { $gte: ['$localSentAt', localSentCutoff] },
              ],
            },
          },
        },
      },
    },
    { $match: { $or: [{ normalEligible: true }, { updatedEligible: true }] } },
    {
      $facet: {
        page: [
          { $match: pageMatch },
          { $sort: { sortAt: -1, orderIdNumeric: -1, _id: 1 } },
          { $skip: skip },
          { $limit: safePageSize },
          { $project: { _id: 0, orderId: '$_id' } },
        ],
        pageTotal: [
          { $match: pageMatch },
          { $count: 'count' },
        ],
        counts: [
          { $match: { normalEligible: true } },
          { $group: { _id: '$displayStage', count: { $sum: 1 } } },
        ],
        updatedCount: [
          { $match: { updatedEligible: true } },
          { $count: 'count' },
        ],
      },
    },
  ];

  const packedByQuery = safeWorkflow === 'packed'
    ? BaseLinkerPickingOrder.aggregate([
      {
        $match: {
          accountScope: scope.accountScope,
          packedBy: { $nin: ['', null] },
          upstreamDisposition: { $in: ['', 'intake'] },
          $or: [{ workflowStage: 'packed' }, { status: 'packed' }],
        },
      },
      // Keep the display name from the most recent packing event for this
      // Telegram actor. Historical rows stay filterable by stable packedBy id.
      { $sort: { packedAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$packedBy',
          name: { $first: '$packedByName' },
          count: { $sum: 1 },
          lastPackedAt: { $first: '$packedAt' },
        },
      },
      { $sort: { name: 1, _id: 1 } },
    ])
    : Promise.resolve([]);

  const [facetRows, packedByRows] = await Promise.all([
    BaseLinkerOrderCache.aggregate(pipeline).allowDiskUse(false),
    packedByQuery,
  ]);
  const facet = facetRows?.[0] || {};
  const pageGroups = Array.isArray(facet?.page) ? facet.page : [];
  const workflowCounts = { processing: 0, deferred: 0, packed: 0, sent: 0, updated: Number(facet?.updatedCount?.[0]?.count || 0) };
  for (const row of facet?.counts || []) {
    if (Object.prototype.hasOwnProperty.call(workflowCounts, row?._id)) workflowCounts[row._id] = Number(row.count || 0);
  }
  const packedByOptions = (packedByRows || []).map((row) => ({
    value: String(row?._id || ''),
    label: String(row?.name || row?._id || ''),
    count: Number(row?.count || 0),
  })).filter((row) => row.value);

  const orderIds = pageGroups.map((row) => String(row.orderId || '')).filter(Boolean);
  const docs = orderIds.length ? await BaseLinkerOrderCache.find({
    accountScope: scope.accountScope,
    orderId: { $in: orderIds },
  }).lean() : [];
  const orderRank = new Map(orderIds.map((id, index) => [id, index]));
  docs.sort((a, b) => {
    const rank = (orderRank.get(String(a.orderId)) ?? 999999) - (orderRank.get(String(b.orderId)) ?? 999999);
    if (rank !== 0) return rank;
    const dateDiff = Number(a.sortAt || 0) - Number(b.sortAt || 0);
    if (dateDiff !== 0) return dateDiff;
    return Number(a.orderIdNumeric || 0) - Number(b.orderIdNumeric || 0);
  });

  if ((await getQueueScope()).scopeKey !== scope.scopeKey) throw appError('baselinker_queue_warming');
  const total = Number(facet?.pageTotal?.[0]?.count || 0);
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  return {
    orders: docs.map((doc) => compactOrder(doc.order)).filter(Boolean),
    page: Math.min(safePage, pageCount),
    pageSize: safePageSize,
    pageCount,
    total,
    workflowCounts,
    packedByOptions,
    activePackedBy: safeWorkflow === 'packed' ? safePackedBy : '',
    sentRetentionDays: 30,
  };
}

module.exports = {
  CACHE_STATE_KEY,
  CACHE_BOOTSTRAP_MAX_PAGES,
  cacheState,
  syncBaseLinkerOrderCache,
  orderSearchText,
  upsertCachedOrders,
  removeCachedOrders,
  ensureBaseLinkerOrderCacheReady,
  refreshBaseLinkerOrderCache,
  getKnownCachedOrderIds,
  getCachedOrderPage,
};
