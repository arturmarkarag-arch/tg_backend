'use strict';

const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const AppSetting = require('../models/AppSetting');
const { warmBaseLinkerProductCatalog } = require('./baseLinkerProducts');
const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');

// The queue poll already owns the BaseLinker request cadence. Piggyback a small,
// rotating history page on that poll so pre-existing Sent/Deferred orders are
// eventually enriched too, without making worker page reads call BaseLinker.
const TRACKED_IMAGE_SWEEP_ORDERS = Math.min(
  100,
  Math.max(10, Number(process.env.BASELINKER_TRACKED_IMAGE_SWEEP_ORDERS) || 50),
);
const TRACKED_IMAGE_SWEEP_REQUESTS = Math.min(
  5,
  Math.max(1, Number(process.env.BASELINKER_TRACKED_IMAGE_SWEEP_REQUESTS) || 3),
);

const SWEEP_STATE_PREFIX = 'baselinker.productImageSweep.v1';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function sweepStateKey(accountId) {
  return `${SWEEP_STATE_PREFIX}:${clean(accountId)}`;
}

async function loadSweepCursor(accountId) {
  const row = await AppSetting.findOne({ key: sweepStateKey(accountId) }).select('value.cursor').lean();
  return clean(row?.value?.cursor) || null;
}

async function saveSweepState(accountId, cursor, stats) {
  await AppSetting.findOneAndUpdate(
    { key: sweepStateKey(accountId) },
    { $set: { value: { cursor: clean(cursor), lastRunAt: new Date(), ...stats } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function orderFromTrackedDoc(doc) {
  const accountId = clean(doc?.baseLinkerAccountId);
  const orderId = clean(doc?.orderId);
  if (!accountId || !orderId) return null;
  return {
    baseLinkerAccountId: accountId,
    order_id: Number.isSafeInteger(Number(orderId)) ? Number(orderId) : orderId,
    order_source: clean(doc?.sourceType).toLowerCase(),
    order_source_id: clean(doc?.sourceId),
    products: (Array.isArray(doc?.items) ? doc.items : []).map((item) => ({
      order_product_id: clean(item?.orderProductId),
      storage: clean(item?.storage).toLowerCase(),
      storage_id: clean(item?.storageId),
      product_id: clean(item?.productId),
      variant_id: clean(item?.variantId),
      auction_id: clean(item?.auctionId),
      sku: clean(item?.sku),
      ean: clean(item?.ean),
      name: clean(item?.name),
      attributes: clean(item?.attributes),
      quantity: Number(item?.requestedQty || 0),
    })),
  };
}

async function trackedPage(accountId, cursor, limit) {
  const query = { baseLinkerAccountId: accountId };
  if (cursor) query._id = { $lt: cursor };
  return BaseLinkerPickingOrder.find(query)
    .select('baseLinkerAccountId orderId sourceType sourceId items')
    .sort({ _id: -1 })
    .limit(limit)
    .lean();
}

async function sweepTrackedProductImages(accountId, {
  orderLimit = TRACKED_IMAGE_SWEEP_ORDERS,
  maxRequests = TRACKED_IMAGE_SWEEP_REQUESTS,
  callApi = null,
} = {}) {
  const id = clean(accountId);
  if (!id) return { skipped: true, reason: 'account_id_missing' };

  const limit = Math.min(100, Math.max(1, Number(orderLimit) || TRACKED_IMAGE_SWEEP_ORDERS));
  let cursor = await loadSweepCursor(id);
  let docs = await trackedPage(id, cursor, limit);
  let wrapped = false;
  if (!docs.length && cursor) {
    cursor = null;
    wrapped = true;
    docs = await trackedPage(id, null, limit);
  }
  if (!docs.length) {
    const empty = { ordersScanned: 0, wrapped, requestCount: 0, attempted: 0, resolvedThisRun: 0, warnings: 0 };
    await saveSweepState(id, '', empty);
    return empty;
  }

  const orders = docs.map(orderFromTrackedDoc).filter((order) => order && order.products.length);
  const caller = callApi || makeBaseLinkerAccountCaller(id, { usageStage: 'tracked_product_image_sweep' });
  const result = await warmBaseLinkerProductCatalog(orders, caller, {
    maxRequests: Math.min(5, Math.max(1, Number(maxRequests) || TRACKED_IMAGE_SWEEP_REQUESTS)),
    linkedOnly: false,
  });

  const warm = result?.productCatalogWarmStats || {};
  const stats = {
    ordersScanned: docs.length,
    wrapped,
    requestCount: Number(warm.requestCount || 0),
    attempted: Number(warm.attempted || 0),
    resolvedThisRun: Number(warm.resolvedThisRun || 0),
    warnings: Number(warm.warnings || 0),
  };
  const lastId = docs[docs.length - 1]?._id;
  const nextCursor = lastId && docs.length >= limit ? lastId : '';
  await saveSweepState(id, nextCursor, stats);
  return stats;
}

module.exports = {
  TRACKED_IMAGE_SWEEP_ORDERS,
  TRACKED_IMAGE_SWEEP_REQUESTS,
  orderFromTrackedDoc,
  sweepTrackedProductImages,
};
