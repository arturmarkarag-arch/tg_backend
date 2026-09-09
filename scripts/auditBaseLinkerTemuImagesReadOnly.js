'use strict';

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
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');
const { makeBaseLinkerAccountCaller } = require('../services/baseLinkerClient');
const { catalogKeyForOrderProduct, fetchBaseLinkerProductCatalog } = require('../services/baseLinkerProducts');

const ACCOUNT_ID = 'cda6810e-1f98-4cb6-872e-e46213862102';
const SOURCE_TYPE = 'temupl';
const SOURCE_ID = '10999';
const ALLOWED = new Set([
  'getOrders', 'getOrderSources', 'getExternalStoragesList', 'getInventories',
  'getInventoryProductsList', 'getInventoryProductsData', 'getProductsList', 'getProductsData',
]);

function clean(value) { return value == null ? '' : String(value).trim(); }
function bump(target, key, amount = 1) { target[key] = Number(target[key] || 0) + amount; }
function errorView(error) {
  return {
    code: clean(error?.code) || 'request_failed',
    message: clean(error?.message),
    details: error?.details || error?.meta || null,
  };
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

  const docs = await BaseLinkerOrderIndex.find({
    baseLinkerAccountId: ACCOUNT_ID,
    sourceType: SOURCE_TYPE,
    sourceId: SOURCE_ID,
  }).select('orderId preview').sort({ orderIdNumeric: -1 }).lean();
  const orders = docs.map((doc) => ({
    ...(doc.preview || {}),
    baseLinkerAccountId: ACCOUNT_ID,
    order_id: Number(doc.orderId),
  }));

  const rows = [];
  for (const order of orders) {
    for (const product of Array.isArray(order.products) ? order.products : []) {
      rows.push({
        orderId: clean(order.order_id),
        product,
        key: catalogKeyForOrderProduct(product, ACCOUNT_ID, order.order_source, order.order_id),
      });
    }
  }
  const cache = await BaseLinkerProductImageCache.find({ productKey: { $in: rows.map((row) => row.key).filter(Boolean) } })
    .select('productKey state imageUrl resolverVersion refreshedAt').lean();
  const cacheByKey = new Map(cache.map((row) => [clean(row.productKey), row]));

  const identity = {};
  const before = { total: rows.length, visible: 0, missing: 0, orders: orders.length, missingOrders: new Set() };
  const missingRows = [];
  for (const row of rows) {
    const product = row.product;
    const storage = clean(product.storage).toLowerCase() || 'blank';
    const storageId = clean(product.storage_id) || 'blank';
    const linked = clean(product.product_id) ? 'product_id_present' : 'product_id_blank';
    const cacheRow = cacheByKey.get(row.key);
    const visible = Boolean(clean(product.image_url) || (clean(cacheRow?.state) === 'resolved' && clean(cacheRow?.imageUrl)));
    bump(identity, `${storage}|${storageId}|${linked}|${visible ? 'photo' : 'no_photo'}`);
    if (visible) before.visible += 1;
    else {
      before.missing += 1;
      before.missingOrders.add(row.orderId);
      missingRows.push({
        orderId: row.orderId,
        orderProductId: clean(product.order_product_id),
        storage,
        storageId,
        productId: clean(product.product_id),
        auctionId: clean(product.auction_id),
        skuPresent: Boolean(clean(product.sku)),
        eanPresent: Boolean(clean(product.ean)),
        namePresent: Boolean(clean(product.name)),
        cacheState: clean(cacheRow?.state) || 'not_cached',
      });
    }
  }

  const upstream = makeBaseLinkerAccountCaller(ACCOUNT_ID, { usageStage: 'temu_image_read_only_audit' });
  const calls = [];
  const callApi = async (method, parameters = {}) => {
    if (!ALLOWED.has(method)) throw new Error(`SAFETY BLOCK: ${method}`);
    try {
      const payload = await upstream(method, parameters);
      calls.push({ method, parameters, status: payload?.status || 'SUCCESS' });
      return payload;
    } catch (error) {
      calls.push({ method, parameters, status: 'ERROR', error: errorView(error) });
      throw error;
    }
  };
  const optional = async (method, parameters) => {
    try { return await callApi(method, parameters); }
    catch (error) { return { status: 'ERROR', ...errorView(error) }; }
  };

  const [sources, externalStorages, inventories] = await Promise.all([
    optional('getOrderSources', {}),
    optional('getExternalStoragesList', {}),
    optional('getInventories', {}),
  ]);
  const sourceMetadata = sources?.sources?.[SOURCE_TYPE]?.[SOURCE_ID]
    ?? sources?.sources?.[SOURCE_TYPE]?.[Number(SOURCE_ID)]
    ?? null;
  const sampleOrderIds = [...new Set(missingRows.map((row) => Number(row.orderId)).filter(Number.isSafeInteger))].slice(0, 3);
  const exactOrders = [];
  for (const orderId of sampleOrderIds) {
    exactOrders.push(await optional('getOrders', {
      order_id: orderId,
      get_unconfirmed_orders: true,
      include_custom_extra_fields: true,
      include_commissions: true,
      include_connect_data: true,
    }));
  }

  const storageProbe = await optional('getProductsList', {
    storage_id: `shop_${SOURCE_ID}`,
    page: 1,
    filter_sort: 'id ASC',
  });
  const resolver = await fetchBaseLinkerProductCatalog(orders, callApi);
  const reasonCounts = {};
  for (const row of rows) {
    const entry = resolver.productCatalog?.[row.key];
    const hasImage = Array.isArray(entry?.images) && entry.images.some((value) => clean(value));
    if (!hasImage) bump(reasonCounts, clean(entry?.state) || 'not_returned');
  }

  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    source: { accountId: ACCOUNT_ID, sourceType: SOURCE_TYPE, sourceId: SOURCE_ID, metadata: sourceMetadata },
    counts: {
      orders: before.orders,
      productLines: before.total,
      visiblePhotos: before.visible,
      missingPhotos: before.missing,
      affectedOrders: before.missingOrders.size,
    },
    identityBreakdown: identity,
    missingReasonAfterFreshRead: reasonCounts,
    missingRows,
    officialStorageVisibility: {
      externalStorages,
      inventories,
      shop10999Probe: storageProbe,
    },
    exactOrderSamples: exactOrders.map((payload) => ({
      status: payload?.status,
      orders: (payload?.orders || []).map((order) => ({
        order_id: order.order_id,
        order_source: order.order_source,
        order_source_id: order.order_source_id,
        products: order.products,
      })),
      ...(payload?.status === 'ERROR' ? payload : {}),
    })),
    resolverStats: resolver.productCatalogStats,
    resolverWarnings: resolver.productCatalogWarnings,
    readOnlyCalls: calls,
  }, null, 2));
}

main()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(async () => {
    try { await mongoose.connection.close(false); } catch (_) { /* ignore */ }
    process.exit(process.exitCode || 0);
  });

