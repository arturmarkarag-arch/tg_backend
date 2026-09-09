'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(envPath)) { dotenv.config({ path: envPath }); break; }
}

const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');
const { makeBaseLinkerAccountCaller } = require('../services/baseLinkerClient');
const { catalogKeyForOrderProduct, fetchBaseLinkerProductCatalog, normalizeImageUrls } = require('../services/baseLinkerProducts');

const ACCOUNT_ID = 'cda6810e-1f98-4cb6-872e-e46213862102';
const INVENTORY_ID = 11049;
const SOURCES = [
  { type: 'allegro', id: '12179' },
  { type: 'erli_connector', id: '17825' },
  { type: 'temupl', id: '10999' },
];
const ALLOWED = new Set([
  'getOrders', 'getOrderSources', 'getInventories', 'getExternalStoragesList',
  'getInventoryProductsList', 'getInventoryProductsData', 'getProductsList', 'getProductsData',
]);

function clean(value) { return value == null ? '' : String(value).trim(); }
function exact(value) { return clean(value).replace(/\s+/g, ' ').toLocaleLowerCase('pl-PL'); }
function signature(value) {
  return exact(value).normalize('NFKD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu)?.sort().join('|') || '';
}
function values(list) { return [...new Set(list.map(clean).filter(Boolean))]; }
function chunk(list, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
function isServiceLine(product) {
  return exact(product?.sku) === 'temu_discount'
    || (exact(product?.name).startsWith('temu rabat:') && Number(product?.price_brutto || 0) <= 0);
}
function sourceId(order) { return `${clean(order?.order_source).toLowerCase()}|${clean(order?.order_source_id)}`; }
function offerIdentity(order, product) {
  const auctionId = clean(product?.auction_id);
  if (auctionId && auctionId !== '0') return `${sourceId(order)}|offer:${auctionId}`;
  const productId = clean(product?.product_id);
  if (productId) return `${sourceId(order)}|product:${productId}`;
  return `${sourceId(order)}|order:${clean(order?.order_id)}|line:${clean(product?.order_product_id)}`;
}
function rowsFromList(payload) {
  const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
  return Object.entries(products).map(([id, row]) => ({ id: clean(row?.id ?? row?.product_id ?? id), row }));
}
function errorView(error) {
  return { code: clean(error?.code) || 'request_failed', message: clean(error?.message), details: error?.details || null };
}

async function main() {
  if (!clean(process.env.MONGODB_URI)) throw new Error('MONGODB_URI is required');
  if (!clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY)) throw new Error('BASELINKER_TOKEN_ENCRYPTION_KEY is required');
  await mongoose.connect(process.env.MONGODB_URI, {
    autoCreate: false, autoIndex: false, readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 20_000, socketTimeoutMS: 120_000,
  });

  const docs = await BaseLinkerOrderIndex.find({
    baseLinkerAccountId: ACCOUNT_ID,
    $or: SOURCES.map((source) => ({ sourceType: source.type, sourceId: source.id })),
  }).select('orderId preview').sort({ orderIdNumeric: -1 }).lean();
  const orders = docs.map((doc) => ({ ...(doc.preview || {}), baseLinkerAccountId: ACCOUNT_ID, order_id: Number(doc.orderId) }));
  const allRows = orders.flatMap((order) => (order.products || []).map((product) => ({
    order, product,
    key: catalogKeyForOrderProduct(product, ACCOUNT_ID, order.order_source, order.order_id),
  })));
  const cacheRows = await BaseLinkerProductImageCache.find({ productKey: { $in: allRows.map((row) => row.key).filter(Boolean) } })
    .select('productKey state imageUrl resolverVersion refreshedAt').lean();
  const cacheByKey = new Map(cacheRows.map((row) => [clean(row.productKey), row]));
  const missingRows = allRows.filter(({ product, key }) => {
    if (isServiceLine(product)) return false;
    const cache = cacheByKey.get(key);
    return !clean(product.image_url) && !(clean(cache?.state) === 'resolved' && clean(cache?.imageUrl));
  });

  const upstream = makeBaseLinkerAccountCaller(ACCOUNT_ID, { usageStage: 'missing_image_forensics_read_only' });
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

  const [sourcePayload, inventories, externalStorages, inventoryList, freshResolver] = await Promise.all([
    optional('getOrderSources', {}),
    optional('getInventories', {}),
    optional('getExternalStoragesList', {}),
    optional('getInventoryProductsList', { inventory_id: INVENTORY_ID, page: 1, include_variants: true, filter_sort: 'id ASC' }),
    fetchBaseLinkerProductCatalog(orders, callApi),
  ]);
  const inventoryRows = rowsFromList(inventoryList);
  const inventoryById = new Map(inventoryRows.map((item) => [item.id, item.row]));

  const directIds = values(missingRows.map(({ product }) => product.product_id));
  const directProducts = {};
  for (const ids of chunk(directIds)) {
    const payload = await optional('getInventoryProductsData', {
      inventory_id: INVENTORY_ID,
      products: ids.map((id) => Number.isSafeInteger(Number(id)) ? Number(id) : id),
      include_channels_media: true,
    });
    Object.assign(directProducts, payload?.products || {});
  }

  const grouped = new Map();
  for (const row of missingRows) {
    const id = offerIdentity(row.order, row.product);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }

  const candidateIds = new Set();
  const analyses = [];
  for (const [identity, group] of grouped) {
    const productIds = values(group.map(({ product }) => product.product_id));
    const auctionIds = values(group.map(({ product }) => product.auction_id)).filter((id) => id !== '0');
    const skus = values(group.map(({ product }) => product.sku));
    const eans = values(group.map(({ product }) => product.ean));
    const names = values(group.map(({ product }) => product.name));
    const eanMatches = inventoryRows.filter(({ row }) => eans.some((value) => exact(row?.ean) === exact(value))).map(({ id }) => id);
    const skuMatches = inventoryRows.filter(({ row }) => skus.some((value) => exact(row?.sku) === exact(value))).map(({ id }) => id);
    const nameMatches = inventoryRows.filter(({ row }) => names.some((value) => signature(row?.name) === signature(value))).map(({ id }) => id);
    const signalIds = values([...eanMatches, ...skuMatches, ...nameMatches]);
    signalIds.forEach((id) => candidateIds.add(id));
    const resolverStates = values(group.map(({ key }) => freshResolver.productCatalog?.[key]?.state));
    const returnedDirectIds = productIds.filter((id) => directProducts[id] || directProducts[String(id)]);
    let rootCause = 'unlinked_marketplace_offer_not_uniquely_present_in_inventory';
    if (productIds.length && returnedDirectIds.length === 0) {
      rootCause = signalIds.length === 1
        ? 'stale_or_deleted_product_id_with_unique_replacement_candidate'
        : 'catalog_product_id_not_returned_and_no_unique_replacement';
    } else if (signalIds.length === 1) rootCause = 'unique_exact_candidate_should_be_resolvable';
    else if (signalIds.length > 1) rootCause = 'identity_signals_match_multiple_catalog_products';
    if (group.some(({ product }) => clean(product.storage).toLowerCase() === 'shop')) rootCause = 'external_shop_storage_not_connected';

    analyses.push({
      identity,
      source: sourceId(group[0].order),
      occurrences: group.length,
      orderIds: values(group.map(({ order }) => order.order_id)),
      storage: values(group.map(({ product }) => `${clean(product.storage)}|${clean(product.storage_id)}`)),
      productIds,
      productIdsPresentInInventoryList: productIds.filter((id) => inventoryById.has(id)),
      productIdsReturnedByDataApi: returnedDirectIds,
      auctionIds,
      skus,
      eans,
      names,
      exactCatalogCandidates: { byEan: values(eanMatches), bySku: values(skuMatches), byCanonicalName: values(nameMatches), union: signalIds },
      resolverStates,
      rootCause,
    });
  }

  const candidateProducts = {};
  for (const ids of chunk([...candidateIds])) {
    if (!ids.length) continue;
    const payload = await optional('getInventoryProductsData', {
      inventory_id: INVENTORY_ID,
      products: ids.map((id) => Number.isSafeInteger(Number(id)) ? Number(id) : id),
      include_channels_media: true,
    });
    Object.assign(candidateProducts, payload?.products || {});
  }
  for (const analysis of analyses) {
    analysis.exactCandidateMedia = analysis.exactCatalogCandidates.union.map((id) => ({
      id,
      images: normalizeImageUrls(candidateProducts[id]?.images || candidateProducts[String(id)]?.images),
    }));
  }

  const sampleOrderIds = SOURCES.map((source) => {
    const match = analyses.find((row) => row.source === `${source.type}|${source.id}`);
    return Number(match?.orderIds?.[0]);
  }).filter(Number.isSafeInteger);
  const exactSamples = [];
  for (const orderId of sampleOrderIds) {
    const payload = await optional('getOrders', { order_id: orderId, get_unconfirmed_orders: true, include_custom_extra_fields: true, include_commissions: true, include_connect_data: true });
    exactSamples.push({ orderId, status: payload?.status, products: payload?.orders?.[0]?.products || [], error: payload?.status === 'ERROR' ? payload : undefined });
  }

  const summaryBySource = {};
  for (const source of SOURCES) {
    const id = `${source.type}|${source.id}`;
    const sourceOrders = orders.filter((order) => sourceId(order) === id);
    const sourceRows = allRows.filter(({ order, product }) => sourceId(order) === id && !isServiceLine(product));
    const sourceMissing = missingRows.filter(({ order }) => sourceId(order) === id);
    summaryBySource[id] = {
      name: sourcePayload?.sources?.[source.type]?.[source.id] ?? null,
      orders: sourceOrders.length,
      realProductLines: sourceRows.length,
      missingLines: sourceMissing.length,
      affectedOrders: new Set(sourceMissing.map(({ order }) => clean(order.order_id))).size,
      uniqueOfferGroups: analyses.filter((row) => row.source === id).length,
      rootCauses: analyses.filter((row) => row.source === id).reduce((acc, row) => {
        acc[row.rootCause] = Number(acc[row.rootCause] || 0) + row.occurrences;
        return acc;
      }, {}),
    };
  }

  const report = {
    measuredAt: new Date().toISOString(),
    summaryBySource,
    analyses,
    officialVisibility: { inventories, externalStorages },
    resolver: { stats: freshResolver.productCatalogStats, warnings: freshResolver.productCatalogWarnings },
    exactOrderSamples: exactSamples,
    readOnlyCalls: calls,
  };
  const output = path.resolve(__dirname, '../../.dev-tools/baselinker-missing-image-forensics.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ output, summaryBySource, analyses }, null, 2));
}

main()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(async () => {
    try { await mongoose.connection.close(false); } catch (_) { /* ignore */ }
    process.exit(process.exitCode || 0);
  });

