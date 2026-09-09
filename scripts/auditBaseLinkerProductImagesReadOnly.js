'use strict';

// Read-only production diagnostic for the BaseLinker order-photo resolver.
// It reads the local order projections and calls only documented BaseLinker
// product read methods. It never persists cache rows or changes an order.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerAccount = require('../models/BaseLinkerAccount');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');
const AppSetting = require('../models/AppSetting');
const {
  catalogKeyForOrderProduct,
  fetchBaseLinkerProductCatalog,
  normalizeImageUrls,
} = require('../services/baseLinkerProducts');
const { makeBaseLinkerAccountCaller } = require('../services/baseLinkerClient');

const ALLOWED_METHODS = new Set([
  'getInventoryProductsList',
  'getInventoryProductsData',
  'getProductsList',
  'getProductsData',
]);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function trackedOrder(doc) {
  return {
    baseLinkerAccountId: clean(doc.baseLinkerAccountId),
    order_id: Number.isSafeInteger(Number(doc.orderId)) ? Number(doc.orderId) : clean(doc.orderId),
    order_source: clean(doc.sourceType).toLowerCase(),
    order_source_id: clean(doc.sourceId),
    products: (Array.isArray(doc.items) ? doc.items : []).map((item) => ({
      order_product_id: clean(item.orderProductId),
      storage: clean(item.storage).toLowerCase(),
      storage_id: clean(item.storageId),
      product_id: clean(item.productId),
      variant_id: clean(item.variantId),
      auction_id: clean(item.auctionId),
      sku: clean(item.sku),
      ean: clean(item.ean),
      name: clean(item.name),
      quantity: Number(item.requestedQty || 0),
    })),
  };
}

function bump(map, key, amount = 1) {
  map[key] = Number(map[key] || 0) + amount;
}

async function main() {
  if (!clean(process.env.MONGODB_URI)) throw new Error('MONGODB_URI is required');
  if (!clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY)) throw new Error('BASELINKER_TOKEN_ENCRYPTION_KEY is required');

  await mongoose.connect(process.env.MONGODB_URI, {
    autoCreate: false,
    autoIndex: false,
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 20_000,
    socketTimeoutMS: 120_000,
  });

  const [indexedDocs, trackedDocs, accounts, cacheRows, cacheVersions, sweepStates] = await Promise.all([
    BaseLinkerOrderIndex.find({}).select('baseLinkerAccountId orderId preview').lean(),
    BaseLinkerPickingOrder.find({}).select('baseLinkerAccountId orderId sourceType sourceId items workflowStage').lean(),
    BaseLinkerAccount.find({}).select('accountId name').lean(),
    BaseLinkerProductImageCache.find({})
      .select('productKey state imageUrl resolverVersion refreshedAt').lean(),
    BaseLinkerProductImageCache.aggregate([
      { $group: { _id: { resolverVersion: '$resolverVersion', state: '$state' }, count: { $sum: 1 } } },
      { $sort: { '_id.resolverVersion': 1, '_id.state': 1 } },
    ]),
    AppSetting.find({ key: /^baselinker\.productImageSweep\.v1:/ }).select('key value').lean(),
  ]);

  const indexedOrders = indexedDocs
    .map((doc) => ({ ...(doc.preview || {}), baseLinkerAccountId: clean(doc.baseLinkerAccountId), order_id: Number(doc.orderId) }))
    .filter((order) => order.baseLinkerAccountId && Array.isArray(order.products));
  const trackedOrders = trackedDocs.map(trackedOrder).filter((order) => order.baseLinkerAccountId && order.products.length);
  const orders = [...indexedOrders, ...trackedOrders];
  const accountNames = Object.fromEntries(accounts.map((row) => [clean(row.accountId), clean(row.name)]));

  const groups = new Map();
  for (const order of orders) {
    const accountId = clean(order.baseLinkerAccountId);
    if (!groups.has(accountId)) groups.set(accountId, []);
    groups.get(accountId).push(order);
  }

  const catalogs = {};
  const persistedByKey = new Map(cacheRows.map((row) => [clean(row.productKey), row]));
  const persistedImages = new Map(cacheRows
    .filter((row) => clean(row.state) === 'resolved' && clean(row.imageUrl))
    .map((row) => [clean(row.productKey), clean(row.imageUrl)]));
  const api = {};
  const warnings = [];
  for (const [accountId, accountOrders] of groups) {
    const upstream = makeBaseLinkerAccountCaller(accountId, { usageStage: 'product_image_read_only_audit' });
    const counters = { total: 0, byMethod: {} };
    const safeCaller = async (method, parameters = {}) => {
      if (!ALLOWED_METHODS.has(method)) throw new Error(`SAFETY BLOCK: ${method}`);
      counters.total += 1;
      bump(counters.byMethod, method);
      return upstream(method, parameters);
    };
    const result = await fetchBaseLinkerProductCatalog(accountOrders, safeCaller);
    Object.assign(catalogs, result.productCatalog || {});
    api[accountId] = { accountName: accountNames[accountId] || '', ...counters };
    warnings.push(...(result.productCatalogWarnings || []).map((warning) => ({ accountId, ...warning })));
  }

  const missingByReason = {};
  const missingBySource = {};
  const missingBySourceAndReason = {};
  const uniqueMissingBySource = {};
  const uniqueMissingBySourceSets = {};
  const pendingResolvableByKey = {};
  const uniqueMissing = new Set();
  const affectedOrders = new Set();
  let totalLines = 0;
  let missingLines = 0;
  let resolvedLines = 0;
  let currentlyVisibleLines = 0;

  for (const order of orders) {
    const accountId = clean(order.baseLinkerAccountId);
    const orderIdentity = `${accountId}:${clean(order.order_id)}`;
    const source = `${clean(order.order_source).toLowerCase() || 'unknown'}|${clean(order.order_source_id) || 'unknown'}`;
    for (const product of Array.isArray(order.products) ? order.products : []) {
      totalLines += 1;
      const key = catalogKeyForOrderProduct(product, accountId, order.order_source, order.order_id);
      const storedImage = clean(product.image_url);
      const entry = key ? catalogs[key] : null;
      const resolvedImage = normalizeImageUrls(entry?.images)[0] || '';
      const currentlyVisible = Boolean(storedImage || (key && persistedImages.get(key)));
      if (currentlyVisible) currentlyVisibleLines += 1;
      if (!currentlyVisible && resolvedImage && key) {
        if (!pendingResolvableByKey[key]) {
          const persisted = persistedByKey.get(key);
          pendingResolvableByKey[key] = {
            source,
            occurrences: 0,
            persistedState: clean(persisted?.state) || 'not_cached',
            persistedResolverVersion: Number(persisted?.resolverVersion || 0),
          };
        }
        pendingResolvableByKey[key].occurrences += 1;
      }
      if (storedImage || resolvedImage) {
        resolvedLines += 1;
        continue;
      }
      missingLines += 1;
      affectedOrders.add(orderIdentity);
      uniqueMissing.add(key || `${orderIdentity}:${clean(product.order_product_id) || totalLines}`);
      const reason = clean(entry?.state) || (key ? 'not_returned_by_resolver' : 'no_exact_identity');
      bump(missingByReason, reason);
      bump(missingBySource, source);
      if (!missingBySourceAndReason[source]) missingBySourceAndReason[source] = {};
      bump(missingBySourceAndReason[source], reason);
      if (!uniqueMissingBySourceSets[source]) uniqueMissingBySourceSets[source] = new Set();
      uniqueMissingBySourceSets[source].add(key || `${orderIdentity}:${clean(product.order_product_id) || totalLines}`);
    }
  }
  for (const [source, keys] of Object.entries(uniqueMissingBySourceSets)) uniqueMissingBySource[source] = keys.size;

  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    orderCounts: { intake: indexedOrders.length, tracked: trackedOrders.length, total: orders.length },
    lineCounts: {
      total: totalLines,
      currentlyVisible: currentlyVisibleLines,
      currentlyMissing: totalLines - currentlyVisibleLines,
      resolvableAfterSweep: resolvedLines,
      irreduciblyMissingWithCurrentDocumentedSources: missingLines,
    },
    affectedOrders: affectedOrders.size,
    uniqueMissingProductKeys: uniqueMissing.size,
    missingByReason,
    missingBySource,
    missingBySourceAndReason,
    uniqueMissingBySource,
    pendingResolvableByKey,
    baseLinkerReadRequests: api,
    persistedCacheVersions: cacheVersions,
    trackedSweepStates: sweepStates.map((row) => ({ key: row.key, value: row.value })),
    warnings,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.connection.close(false); } catch (_) { /* ignore */ }
    process.exit(process.exitCode || 0);
  });
