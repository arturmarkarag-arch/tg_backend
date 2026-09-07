const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');
const { productKey } = require('./baseLinkerIdentity');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PERSISTED_PRODUCT_CACHE_TTL_MS = Math.max(PRODUCT_CACHE_TTL_MS, Number(process.env.BASELINKER_PRODUCT_CACHE_TTL_MS) || (24 * 60 * 60 * 1000));
const LOOKUP_CHUNK_SIZE = 100;
const productCache = new Map();
let productImageCacheReadyPromise = null;

async function ensureProductImageCacheReady() {
  if (!productImageCacheReadyPromise) {
    productImageCacheReadyPromise = BaseLinkerProductImageCache.createIndexes().catch((error) => {
      productImageCacheReadyPromise = null;
      throw error;
    });
  }
  return productImageCacheReadyPromise;
}

function cleanId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function catalogKeyForOrderProduct(product, accountId = '') {
  const account = cleanId(accountId || product?.baseLinkerAccountId);
  if (!account) throw appError('baselinker_account_id_required');
  return productKey(account, product) || null;
}

function chunk(values, size = LOOKUP_CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function normalizeImageUrls(images) {
  const seen = new Set();
  const urls = [];
  const push = (value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  if (Array.isArray(images)) {
    images.forEach(push);
    return urls;
  }

  if (!images || typeof images !== 'object') return urls;

  // Base inventory galleries use numeric keys for the default gallery and
  // "position|channel" keys for channel-specific overrides. Prefer the
  // default gallery; only fall back to channel media when no default exists.
  const entries = Object.entries(images);
  entries
    .filter(([key]) => /^\d+$/.test(String(key)))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([, value]) => push(value));

  // Keep channel-specific images too. Some sellers use separate/overwrite
  // galleries per marketplace, so discarding these could hide the exact media
  // that identified the ordered item. Duplicates are removed above.
  entries
    .filter(([key]) => !/^\d+$/.test(String(key)))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .forEach(([, value]) => push(value));

  return urls;
}

function getCached(key) {
  const cached = productCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    productCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCached(key, value) {
  productCache.set(key, {
    value,
    expiresAt: Date.now() + PRODUCT_CACHE_TTL_MS,
  });
}

function compactImageEntry(state, images) {
  const first = normalizeImageUrls(images)[0] || '';
  return { state, images: first ? [first] : [] };
}

function inventoryEntry(product) {
  return compactImageEntry('resolved', product?.images);
}

function externalEntry(product) {
  return compactImageEntry('resolved', product?.images);
}

function collectOrderProductRefs(orders) {
  const refsByKey = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const product of Array.isArray(order?.products) ? order.products : []) {
      const accountId = cleanId(order?.baseLinkerAccountId);
      const key = catalogKeyForOrderProduct(product, accountId);
      if (!key || refsByKey.has(key)) continue;
      refsByKey.set(key, {
        key,
        accountId,
        storage: cleanId(product.storage).toLowerCase(),
        storageId: cleanId(product.storage_id),
        productId: cleanId(product.product_id),
      });
    }
  }
  return Array.from(refsByKey.values());
}

async function resolveExternalRefs(refs, productCatalog, warnings, callApi) {
  const groups = new Map();
  for (const ref of refs) {
    const prefix = ref.storage === 'warehouse' ? 'warehouse' : 'shop';
    const apiStorageId = `${prefix}_${ref.storageId}`;
    if (!groups.has(apiStorageId)) groups.set(apiStorageId, []);
    groups.get(apiStorageId).push(ref);
  }

  for (const [apiStorageId, groupRefs] of groups.entries()) {
    const missingRefs = groupRefs.filter((ref) => {
      const cached = getCached(ref.key);
      if (cached) productCatalog[ref.key] = cached;
      return !cached;
    });
    if (!missingRefs.length) continue;

    const byProductId = new Map(missingRefs.map((ref) => [ref.productId, ref]));
    for (const ids of chunk(Array.from(byProductId.keys()))) {
      try {
        const payload = await callApi('getExternalStorageProductsData', {
          storage_id: apiStorageId,
          products: ids,
        });
        const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
        for (const productId of ids) {
          const ref = byProductId.get(String(productId));
          const product = products[productId] ?? products[String(productId)];
          if (!ref || !product) continue;
          const entry = externalEntry(product);
          productCatalog[ref.key] = entry;
          setCached(ref.key, entry);
        }
      } catch (error) {
        warnings.push({
          scope: 'external_storage',
          storageId: apiStorageId,
          code: error?.code || error?.message || 'catalog_lookup_failed',
        });
      }
    }
  }
}

async function tryDirectInventoryRefs(refs, productCatalog, unresolved, warnings, callApi) {
  const groups = new Map();
  for (const ref of refs) {
    const cached = getCached(ref.key);
    if (cached) {
      productCatalog[ref.key] = cached;
      continue;
    }

    const inventoryId = Number(ref.storageId);
    if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
      unresolved.push(ref);
      continue;
    }
    if (!groups.has(inventoryId)) groups.set(inventoryId, []);
    groups.get(inventoryId).push(ref);
  }

  for (const [inventoryId, groupRefs] of groups.entries()) {
    const byProductId = new Map(groupRefs.map((ref) => [ref.productId, ref]));
    const found = new Set();

    for (const ids of chunk(Array.from(byProductId.keys()))) {
      try {
        const payload = await callApi('getInventoryProductsData', {
          inventory_id: inventoryId,
          products: ids.map((id) => Number.isSafeInteger(Number(id)) ? Number(id) : id),
          include_channels_media: false,
        });
        const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
        for (const productId of ids) {
          const ref = byProductId.get(String(productId));
          const product = products[productId] ?? products[String(productId)];
          if (!ref || !product) continue;
          found.add(ref.key);
          const entry = inventoryEntry(product);
          productCatalog[ref.key] = entry;
          setCached(ref.key, entry);
        }
      } catch (error) {
        warnings.push({
          scope: 'inventory_direct',
          inventoryId,
          code: error?.code || error?.message || 'catalog_lookup_failed',
        });
      }
    }

    for (const ref of groupRefs) {
      if (!found.has(ref.key)) unresolved.push(ref);
    }
  }
}

/**
 * Enriches the order lines returned by the current getOrders read without
 * changing/persisting that upstream payload. The catalog is supplementary
 * current product data used for photos, features and packing context.
 */
async function fetchBaseLinkerProductCatalogSingle(orders, callApi, { maxRequests = Number.POSITIVE_INFINITY } = {}) {
  let requestCount = 0;
  const budgetedCallApi = async (method, parameters) => {
    if (requestCount >= maxRequests) throw appError('baselinker_catalog_request_budget_exhausted');
    requestCount += 1;
    return callApi(method, parameters);
  };
  const refs = collectOrderProductRefs(orders);
  const productCatalog = {};
  const warnings = [];

  const internalRefs = refs.filter((ref) => ref.storage === 'db');
  const externalRefs = refs.filter((ref) => ref.storage === 'shop' || ref.storage === 'warehouse');
  const unsupportedRefs = refs.filter((ref) => !['db', 'shop', 'warehouse'].includes(ref.storage));

  await resolveExternalRefs(externalRefs, productCatalog, warnings, budgetedCallApi);

  const unresolvedInternal = [];
  await tryDirectInventoryRefs(internalRefs, productCatalog, unresolvedInternal, warnings, budgetedCallApi);
  // Never guess an inventory by scanning all inventories for a product_id.
  // Without an exact storage_id from the ordered line there is no authoritative
  // catalog binding, so fail closed and show no enriched image.
  for (const ref of unresolvedInternal) {
    productCatalog[ref.key] = { state: 'unresolved_exact_source', images: [] };
  }

  for (const ref of unsupportedRefs) {
    productCatalog[ref.key] = { state: 'unsupported_storage', images: [] };
  }

  const resolved = Object.values(productCatalog).filter((entry) => entry?.state === 'resolved').length;
  return {
    productCatalog,
    productCatalogStats: {
      requested: refs.length,
      resolved,
      unresolved: Math.max(0, refs.length - resolved),
      warnings: warnings.length,
    },
    productCatalogWarnings: warnings,
    requestCount,
  };
}

async function getCachedBaseLinkerProductCatalog(orders) {
  await ensureProductImageCacheReady();
  const refs = collectOrderProductRefs(orders);
  if (!refs.length) return {
    productCatalog: {},
    productCatalogStats: { requested: 0, resolved: 0, unresolved: 0, warnings: 0 },
    productCatalogWarnings: [],
  };
  const rows = await BaseLinkerProductImageCache.find({ productKey: { $in: refs.map((ref) => ref.key) } })
    .select('productKey state imageUrl refreshedAt').lean();
  const byKey = new Map(rows.map((row) => [String(row.productKey), row]));
  const productCatalog = {};
  let resolved = 0;
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    if (!row) continue;
    const image = String(row.imageUrl || '').trim();
    productCatalog[ref.key] = { state: String(row.state || 'unresolved'), images: image ? [image] : [] };
    if (String(row.state || '') === 'resolved') resolved += 1;
  }
  return {
    productCatalog,
    productCatalogStats: { requested: refs.length, resolved, unresolved: Math.max(0, refs.length - resolved), warnings: 0 },
    productCatalogWarnings: [],
  };
}

async function warmBaseLinkerProductCatalog(orders, callApi, { maxRequests = 5 } = {}) {
  await ensureProductImageCacheReady();
  const list = Array.isArray(orders) ? orders : [];
  const refs = collectOrderProductRefs(list);
  if (!refs.length || typeof callApi !== 'function' || maxRequests <= 0) return getCachedBaseLinkerProductCatalog(list);
  const cutoff = new Date(Date.now() - PERSISTED_PRODUCT_CACHE_TTL_MS);
  const freshRows = await BaseLinkerProductImageCache.find({
    productKey: { $in: refs.map((ref) => ref.key) },
    refreshedAt: { $gte: cutoff },
  }).select('productKey').lean();
  const fresh = new Set(freshRows.map((row) => String(row.productKey)));
  const staleKeys = new Set(refs.filter((ref) => !fresh.has(ref.key)).map((ref) => ref.key));
  if (!staleKeys.size) return getCachedBaseLinkerProductCatalog(list);

  const missingOnlyOrders = list.map((order) => ({
    ...order,
    products: (Array.isArray(order?.products) ? order.products : []).filter((product) => {
      const key = catalogKeyForOrderProduct(product, order?.baseLinkerAccountId);
      return key && staleKeys.has(key);
    }),
  })).filter((order) => order.products.length);

  const freshResult = await fetchBaseLinkerProductCatalogSingle(missingOnlyOrders, callApi, { maxRequests });
  const now = new Date();
  const writes = [];
  for (const [key, entry] of Object.entries(freshResult.productCatalog || {})) {
    const state = String(entry?.state || 'unresolved');
    // Transport/API errors are represented as warnings rather than entries, so
    // only deterministic results reach this cache. A transient failure is never
    // cached as a 24h successful lookup.
    const imageUrl = normalizeImageUrls(entry?.images)[0] || '';
    const accountId = String(key).split(':', 1)[0] || '';
    if (!accountId) continue;
    writes.push({ updateOne: {
      filter: { baseLinkerAccountId: accountId, productKey: key },
      update: { $set: { baseLinkerAccountId: accountId, productKey: key, state, imageUrl, refreshedAt: now } },
      upsert: true,
    } });
  }
  if (writes.length) await BaseLinkerProductImageCache.bulkWrite(writes, { ordered: false });
  return getCachedBaseLinkerProductCatalog(list);
}

async function fetchBaseLinkerProductCatalog(orders, callApi = null) {
  const list = Array.isArray(orders) ? orders : [];
  if (callApi) return fetchBaseLinkerProductCatalogSingle(list, callApi);

  const groups = new Map();
  for (const order of list) {
    const accountId = cleanId(order?.baseLinkerAccountId);
    if (!accountId) throw appError('baselinker_account_id_required');
    if (!groups.has(accountId)) groups.set(accountId, []);
    groups.get(accountId).push(order);
  }

  const merged = {
    productCatalog: {},
    productCatalogStats: { requested: 0, resolved: 0, unresolved: 0, warnings: 0 },
    productCatalogWarnings: [],
  };
  for (const [accountId, groupOrders] of groups) {
    const caller = makeBaseLinkerAccountCaller(accountId);
    const result = await fetchBaseLinkerProductCatalogSingle(groupOrders, caller);
    Object.assign(merged.productCatalog, result.productCatalog || {});
    for (const key of ['requested', 'resolved', 'unresolved', 'warnings']) {
      merged.productCatalogStats[key] += Number(result.productCatalogStats?.[key] || 0);
    }
    merged.productCatalogWarnings.push(...(result.productCatalogWarnings || []).map((warning) => ({
      baseLinkerAccountId: accountId,
      ...warning,
    })));
  }
  return merged;
}

module.exports = {
  catalogKeyForOrderProduct,
  normalizeImageUrls,
  collectOrderProductRefs,
  fetchBaseLinkerProductCatalog,
  getCachedBaseLinkerProductCatalog,
  warmBaseLinkerProductCatalog,
};
