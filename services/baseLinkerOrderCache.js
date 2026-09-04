'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const BaseLinkerOrderCache = require('../models/BaseLinkerOrderCache');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');

const CACHE_STATE_KEY = 'baselinker.orderCache.v1';
const CACHE_BOOTSTRAP_MAX_PAGES = Math.min(90, Math.max(1, Number(process.env.BASELINKER_ORDER_CACHE_BOOTSTRAP_PAGES) || 90));
const PAGE_SIZE_VALUES = new Set([10, 20, 50]);
let indexPromise = null;
let bootstrapPromise = null;

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

function fulfilmentGroupKey(order) {
  const source = String(order?.order_source ?? '').trim().toLowerCase();
  const sourceId = String(order?.order_source_id ?? '').trim();
  const externalOrderId = String(order?.external_order_id ?? '').trim();
  if (externalOrderId) return `external:${source}:${sourceId}:${externalOrderId}`;
  const shopOrderId = String(order?.shop_order_id ?? '').trim();
  if (shopOrderId) return `shop:${source}:${sourceId}:${shopOrderId}`;
  return `order:${String(order?.order_id ?? '').trim()}`;
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
    order?.invoice_fullname,
    order?.invoice_company,
    order?.invoice_nip,
    order?.user_login,
    order?.delivery_package_nr,
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

function cacheRowForOrder(order, syncToken = '') {
  const orderId = String(order?.order_id ?? '').trim();
  if (!orderId) return null;
  return {
    orderId,
    orderIdNumeric: Number(order?.order_id || 0) || 0,
    groupKey: fulfilmentGroupKey(order),
    orderStatusId: Number.isInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
    sortAt: Number(order?.date_confirmed || order?.date_add || 0) || 0,
    searchText: orderSearchText(order),
    order,
    syncToken: String(syncToken || ''),
    upstreamCachedAt: new Date(),
  };
}

async function ensureIndexes() {
  if (!indexPromise) {
    indexPromise = BaseLinkerOrderCache.syncIndexes().catch((error) => {
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

async function upsertCachedOrders(orders, { syncToken = '' } = {}) {
  const rows = (orders || []).map((order) => cacheRowForOrder(order, syncToken)).filter(Boolean);
  if (!rows.length) return 0;
  await ensureIndexes();
  const operations = rows.map((row) => ({
    updateOne: {
      filter: { orderId: row.orderId },
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
  const result = await BaseLinkerOrderCache.deleteMany({ orderId: { $in: ids } });
  return Number(result?.deletedCount || 0);
}

async function cacheState() {
  const row = await AppSetting.findOne({ key: CACHE_STATE_KEY }).lean();
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    initialized: value.initialized === true,
    lastFullSyncAt: value.lastFullSyncAt || null,
    orderCount: Number(value.orderCount || 0),
  };
}

async function saveCacheState(value) {
  await AppSetting.findOneAndUpdate(
    { key: CACHE_STATE_KEY },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function bootstrapCacheUnlocked() {
  await ensureIndexes();
  const syncToken = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const result = await fetchBaseLinkerOrders({
    includeUnconfirmed: true,
    maxPages: CACHE_BOOTSTRAP_MAX_PAGES,
  });

  // A full cache must be complete. Returning a silently truncated cache would
  // make numeric pagination/counts lie to the operator.
  if (result.truncated) {
    throw appError('baselinker_order_cache_bootstrap_truncated', {
      maxOrders: CACHE_BOOTSTRAP_MAX_PAGES * 100,
    });
  }

  await upsertCachedOrders(result.orders, { syncToken });
  // Do not sweep by syncToken here: journal updates can legitimately race a
  // first bootstrap and must never be deleted just because they landed after
  // their row was scanned. Actual removals are applied from getJournalList.
  const orderCount = await BaseLinkerOrderCache.countDocuments();
  const lastFullSyncAt = new Date().toISOString();
  await saveCacheState({ initialized: true, lastFullSyncAt, orderCount });
  return { initialized: true, lastFullSyncAt, orderCount };
}

async function ensureBaseLinkerOrderCacheReady() {
  const current = await cacheState();
  if (current.initialized) {
    const actualCount = await BaseLinkerOrderCache.countDocuments();
    if (actualCount > 0 || current.orderCount === 0) return { ...current, orderCount: actualCount };
  }
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = withLock('baselinker-order-cache-bootstrap', async () => {
    const inside = await cacheState();
    if (inside.initialized) {
      const actualCount = await BaseLinkerOrderCache.countDocuments();
      if (actualCount > 0 || inside.orderCount === 0) return { ...inside, orderCount: actualCount };
    }
    return bootstrapCacheUnlocked();
  }, { ttlMs: 180_000, waitMs: 185_000 });

  try {
    return await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
}

async function refreshBaseLinkerOrderCache({ orders = [], removedOrderIds = [] } = {}) {
  await Promise.all([
    upsertCachedOrders(orders),
    removeCachedOrders(removedOrderIds),
  ]);
}

function displayStageExpression() {
  return {
    $switch: {
      branches: [
        { case: { $eq: ['$localStatus', 'paused'] }, then: 'deferred' },
        { case: { $eq: ['$localStatus', 'packed'] }, then: 'packed' },
        { case: { $eq: ['$localStatus', 'sent'] }, then: 'sent' },
      ],
      default: 'processing',
    },
  };
}

async function getCachedOrderPage({ statusId, workflowFilter = 'processing', search = '', page = 1, pageSize = 10 } = {}) {
  await ensureBaseLinkerOrderCacheReady();

  const safePage = safePositiveInt(page, 1);
  const safePageSize = normalizePageSize(pageSize);
  const safeWorkflow = ['processing', 'deferred', 'packed', 'sent'].includes(String(workflowFilter))
    ? String(workflowFilter)
    : 'processing';
  const match = {};
  const statusNumber = Number(statusId);
  if (statusId !== undefined && statusId !== null && statusId !== '' && statusId !== 'all' && Number.isInteger(statusNumber) && statusNumber >= 0) {
    match.orderStatusId = statusNumber;
  }
  const normalizedSearch = String(search || '').trim().toLowerCase().slice(0, 160);
  if (normalizedSearch) match.searchText = { $regex: escapeRegex(normalizedSearch), $options: 'i' };

  const pickingCollection = BaseLinkerPickingOrder.collection.name;
  const skip = (safePage - 1) * safePageSize;

  const pipeline = [
    { $match: match },
    { $sort: { sortAt: -1, orderIdNumeric: -1 } },
    {
      $group: {
        _id: '$groupKey',
        sortAt: { $min: '$sortAt' },
        orderIdNumeric: { $max: '$orderIdNumeric' },
        memberOrderIds: { $addToSet: '$orderId' },
      },
    },
    {
      $lookup: {
        from: pickingCollection,
        let: { cacheGroupKey: '$_id', cacheMemberOrderIds: '$memberOrderIds' },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$groupKey', '$$cacheGroupKey'] },
                  { $in: ['$orderId', '$$cacheMemberOrderIds'] },
                  {
                    $gt: [
                      {
                        $size: {
                          $setIntersection: [
                            { $ifNull: ['$memberOrderIds', []] },
                            '$$cacheMemberOrderIds',
                          ],
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
          { $project: { _id: 1, status: 1, orderId: 1, groupKey: 1, memberOrderIds: 1 } },
        ],
        as: 'pickingDocs',
      },
    },
    {
      $addFields: {
        localStatus: {
          $cond: [
            { $eq: [{ $size: '$pickingDocs' }, 1] },
            { $ifNull: [{ $arrayElemAt: ['$pickingDocs.status', 0] }, 'new'] },
            'new',
          ],
        },
      },
    },
    { $addFields: { displayStage: displayStageExpression() } },
    {
      $facet: {
        page: [
          { $match: { displayStage: safeWorkflow } },
          { $sort: { sortAt: -1, orderIdNumeric: -1, _id: 1 } },
          { $skip: skip },
          { $limit: safePageSize },
          { $project: { _id: 0, groupKey: '$_id', memberOrderIds: 1 } },
        ],
        counts: [
          { $group: { _id: '$displayStage', count: { $sum: 1 } } },
        ],
      },
    },
  ];

  const [facet] = await BaseLinkerOrderCache.aggregate(pipeline).allowDiskUse(false);
  const pageGroups = Array.isArray(facet?.page) ? facet.page : [];
  const workflowCounts = { processing: 0, deferred: 0, packed: 0, sent: 0 };
  for (const row of facet?.counts || []) {
    if (Object.prototype.hasOwnProperty.call(workflowCounts, row?._id)) workflowCounts[row._id] = Number(row.count || 0);
  }

  const groupKeys = pageGroups.map((row) => String(row.groupKey || '')).filter(Boolean);
  const docs = groupKeys.length
    ? await BaseLinkerOrderCache.find({ groupKey: { $in: groupKeys } }).lean()
    : [];
  const groupRank = new Map(groupKeys.map((key, index) => [key, index]));
  docs.sort((a, b) => {
    const rank = (groupRank.get(a.groupKey) ?? 999999) - (groupRank.get(b.groupKey) ?? 999999);
    if (rank !== 0) return rank;
    const dateDiff = Number(a.sortAt || 0) - Number(b.sortAt || 0);
    if (dateDiff !== 0) return dateDiff;
    return Number(a.orderIdNumeric || 0) - Number(b.orderIdNumeric || 0);
  });

  const total = Number(workflowCounts[safeWorkflow] || 0);
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  return {
    orders: docs.map((doc) => doc.order).filter(Boolean),
    page: Math.min(safePage, pageCount),
    pageSize: safePageSize,
    pageCount,
    total,
    workflowCounts,
  };
}

module.exports = {
  CACHE_STATE_KEY,
  CACHE_BOOTSTRAP_MAX_PAGES,
  fulfilmentGroupKey,
  orderSearchText,
  upsertCachedOrders,
  removeCachedOrders,
  ensureBaseLinkerOrderCacheReady,
  refreshBaseLinkerOrderCache,
  getCachedOrderPage,
};
