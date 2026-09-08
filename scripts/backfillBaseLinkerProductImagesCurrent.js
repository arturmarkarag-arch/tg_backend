'use strict';

/**
 * Refresh recent Sent-order product images using the resolver version currently
 * compiled into services/baseLinkerProducts.js.
 *
 * Safety contract:
 * - requires an explicit BaseLinker account UUID;
 * - reads local Sent history and BaseLinker product data only;
 * - allows only product read methods at the BaseLinker transport boundary;
 * - writes only BaseLinkerProductImageCache through warmBaseLinkerProductCatalog;
 * - never changes orders, customers, statuses, packages or labels.
 *
 * Example:
 *   node scripts/backfillBaseLinkerProductImagesCurrent.js \
 *     --account=cda6810e-1f98-4cb6-872e-e46213862102 \
 *     --days=14 --requests-per-minute=10
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

if (process.env.NODE_ENV !== 'production') {
  for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      break;
    }
  }
}

const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { warmBaseLinkerProductCatalog } = require('../services/baseLinkerProducts');
const { makeBaseLinkerAccountCaller } = require('../services/baseLinkerClient');
const { getBaseLinkerAccount } = require('../services/baseLinkerAccounts');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 60_000;
const ALLOWED_METHODS = new Set([
  'getInventoryProductsList',
  'getInventoryProductsData',
  'getProductsData',
]);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function intArg(name, fallback, min, max) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RollingLimiter {
  constructor(limit) {
    this.limit = limit;
    this.events = [];
  }

  async take() {
    while (true) {
      const now = Date.now();
      this.events = this.events.filter((timestamp) => now - timestamp < WINDOW_MS);
      if (this.events.length < this.limit) {
        this.events.push(now);
        return;
      }
      await sleep(Math.max(1000, WINDOW_MS - (now - this.events[0]) + 250));
    }
  }
}

function orderFromPickingDoc(doc) {
  return {
    baseLinkerAccountId: clean(doc.baseLinkerAccountId),
    order_id: Number(doc.orderId),
    order_source: clean(doc.sourceType).toLowerCase(),
    order_source_id: clean(doc.sourceId),
    products: (Array.isArray(doc.items) ? doc.items : []).map((item) => ({
      order_product_id: clean(item.orderProductId),
      storage: clean(item.storage),
      storage_id: clean(item.storageId),
      product_id: clean(item.productId),
      variant_id: clean(item.variantId),
      auction_id: clean(item.auctionId),
      sku: clean(item.sku),
      ean: clean(item.ean),
      name: clean(item.name),
      attributes: clean(item.attributes),
      quantity: Number(item.requestedQty || 0),
    })),
  };
}

async function main() {
  const accountId = clean(argValue('account'));
  const days = intArg('days', 14, 1, 60);
  const requestsPerMinute = intArg('requests-per-minute', 10, 1, 40);
  const maxRequests = intArg('max-requests', 20, 1, 40);
  if (!accountId) throw new Error('--account=<BaseLinker account UUID> is required');
  if (!clean(process.env.MONGODB_URI)) throw new Error('MONGODB_URI is required');
  if (!clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY)) {
    throw new Error('BASELINKER_TOKEN_ENCRYPTION_KEY is required');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20_000,
    socketTimeoutMS: 60_000,
  });

  const account = await getBaseLinkerAccount(accountId, { lean: true });
  if (!account || account.enabled !== true) throw new Error('BaseLinker account is missing or disabled');

  const cutoff = new Date(Date.now() - days * DAY_MS);
  const docs = await BaseLinkerPickingOrder.find({
    baseLinkerAccountId: accountId,
    $and: [
      { $or: [{ workflowStage: 'sent' }, { status: 'sent' }] },
      { $or: [{ sentAt: { $gte: cutoff } }, { sentAt: null, updatedAt: { $gte: cutoff } }] },
    ],
  }).select('baseLinkerAccountId orderId sourceType sourceId items sentAt updatedAt').lean();
  const orders = docs.map(orderFromPickingDoc).filter((order) => order.order_id && order.products.length);

  const limiter = new RollingLimiter(requestsPerMinute);
  const counters = { total: 0, byMethod: {} };
  const upstream = makeBaseLinkerAccountCaller(accountId, { usageStage: 'product_image_version_backfill' });
  const safeCaller = async (method, parameters = {}) => {
    if (!ALLOWED_METHODS.has(String(method))) throw new Error(`SAFETY BLOCK: method ${method} is not allowed`);
    await limiter.take();
    counters.total += 1;
    counters.byMethod[method] = Number(counters.byMethod[method] || 0) + 1;
    return upstream(method, parameters);
  };

  console.log(`[image-backfill] account=${accountId} name=${account.name || 'BaseLinker'}`);
  console.log(`[image-backfill] recent Sent orders=${orders.length} cap=${requestsPerMinute}/minute`);
  const result = await warmBaseLinkerProductCatalog(orders, safeCaller, { maxRequests });
  console.log(JSON.stringify({
    productCatalogStats: result.productCatalogStats,
    baseLinkerRequests: counters.total,
    byMethod: counters.byMethod,
  }, null, 2));
  if (Number(result.productCatalogStats?.unresolved || 0) > 0) process.exitCode = 2;
  console.log('[image-backfill] Only BaseLinkerProductImageCache may have changed.');
}

main()
  .catch((error) => {
    console.error('[image-backfill] FAILED:', error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.connection.close(false); } catch (_) { /* ignore */ }
    process.exit(process.exitCode || 0);
  });
