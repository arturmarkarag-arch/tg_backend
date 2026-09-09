const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');
const { productKey } = require('./baseLinkerIdentity');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_PRODUCT_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.BASELINKER_PRODUCT_NEGATIVE_CACHE_TTL_MS) || (60 * 60 * 1000));
const PERSISTED_PRODUCT_CACHE_TTL_MS = Math.max(PRODUCT_CACHE_TTL_MS, Number(process.env.BASELINKER_PRODUCT_CACHE_TTL_MS) || (24 * 60 * 60 * 1000));
const LOOKUP_CHUNK_SIZE = 100;
const STORAGE_LIST_PAGE_SIZE = 1000;
const STORAGE_CATALOG_SNAPSHOT_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.BASELINKER_STORAGE_CATALOG_SNAPSHOT_TTL_MS) || (60 * 60 * 1000));
const UNLINKED_BULK_SCAN_MIN_REFS = Math.max(2, Number(process.env.BASELINKER_UNLINKED_BULK_SCAN_MIN_REFS) || 8);
const STORAGE_CATALOG_MAX_PAGES = Math.max(1, Math.min(100, Number(process.env.BASELINKER_STORAGE_CATALOG_MAX_PAGES) || 50));
const IMAGE_RESOLVER_VERSION = 6;
const UNLINKED_STORAGE_MAX_PER_RUN = Math.min(10, Math.max(1, Number(process.env.BASELINKER_UNLINKED_STORAGE_MAX_PER_RUN || process.env.BASELINKER_UNLINKED_INVENTORY_MAX_PER_RUN) || 4));
const productCache = new Map();
const storageCatalogSnapshots = new Map();
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

function catalogKeyForOrderProduct(product, accountId = '', orderSource = '', orderId = '') {
  const account = cleanId(accountId || product?.baseLinkerAccountId);
  if (!account) throw appError('baselinker_account_id_required');
  const exactProductKey = productKey(account, product);
  if (exactProductKey) return exactProductKey;

  const source = cleanId(orderSource || product?.order_source).toLowerCase();
  const auctionId = cleanId(product?.auction_id);
  // getOrders explicitly allows product_id to be blank when the marketplace
  // order line is not linked to a Base product. In that case auction_id is the
  // only exact item identity we have. Keep it namespaced by account+source so
  // no name/SKU guessing is ever needed.
  if (source === 'allegro' && /^\d{5,30}$/.test(auctionId)) {
    return `${account}:offer:allegro:${auctionId}`;
  }

  // BaseLinker explicitly allows getOrders.products[].product_id to be blank.
  // In that case we still need a stable key for this exact order line so the
  // photo resolver can use the authoritative storage_id + EAN/SKU/name without
  // guessing across inventories or across orders.
  const exactOrderId = cleanId(orderId || product?.order_id);
  const orderProductId = cleanId(product?.order_product_id ?? product?.orderProductId);
  if (exactOrderId && orderProductId) {
    return `${account}:order:${exactOrderId}:line:${orderProductId}`;
  }
  return null;
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

function inventoryImageUrls(product, ref = {}) {
  const images = product?.images;
  if (!images || typeof images !== 'object' || Array.isArray(images)) return normalizeImageUrls(images);

  const channel = cleanId(ref?.sourceType).toLowerCase() && cleanId(ref?.sourceId)
    ? `${cleanId(ref.sourceType).toLowerCase()}_${cleanId(ref.sourceId)}`
    : '';
  if (!channel) return normalizeImageUrls(images);

  const entries = Object.entries(images);
  const defaults = entries
    .filter(([key]) => /^\d+$/.test(String(key)))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const channelRows = entries
    .filter(([key]) => String(key).endsWith(`|${channel}`))
    .sort((a, b) => Number(String(a[0]).split('|', 1)[0]) - Number(String(b[0]).split('|', 1)[0]));
  const mode = Number(product?.media_options?.[channel] ?? 0);

  // 1 = separate gallery, 2 = overwrite inherited positions, 0 = default.
  // For display purposes an exact channel photo is always preferable to an
  // unrelated channel override, while mode=0 preserves the default gallery.
  if (mode === 1) {
    const exact = normalizeImageUrls(Object.fromEntries(channelRows));
    return exact.length ? exact : normalizeImageUrls(Object.fromEntries(defaults));
  }
  if (mode === 2) {
    const defaultByPos = new Map(defaults.map(([key, value]) => [String(key), value]));
    const overrideByPos = new Map(channelRows.map(([key, value]) => [String(key).split('|', 1)[0], value]));
    const positions = [...new Set([...defaultByPos.keys(), ...overrideByPos.keys()])].sort((a, b) => Number(a) - Number(b));
    const resolved = [];
    for (const pos of positions) {
      const value = overrideByPos.has(pos) ? overrideByPos.get(pos) : defaultByPos.get(pos);
      if (String(value || '').trim()) resolved.push(value);
    }
    return normalizeImageUrls(resolved);
  }
  const base = normalizeImageUrls(Object.fromEntries(defaults));
  if (base.length) return base;
  return normalizeImageUrls(Object.fromEntries(channelRows));
}

function inventoryEntry(product, ref = {}) {
  const images = inventoryImageUrls(product, ref);
  return compactImageEntry(images.length ? 'resolved' : 'catalog_no_image', images);
}

function externalEntry(product) {
  const images = normalizeImageUrls(product?.images);
  return compactImageEntry(images.length ? 'resolved' : 'catalog_no_image', images);
}

function collectOrderProductRefs(orders) {
  const refsByKey = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const product of Array.isArray(order?.products) ? order.products : []) {
      const accountId = cleanId(order?.baseLinkerAccountId);
      const sourceType = cleanId(order?.order_source).toLowerCase();
      const key = catalogKeyForOrderProduct(product, accountId, sourceType, order?.order_id);
      if (!key || refsByKey.has(key)) continue;
      refsByKey.set(key, {
        key,
        accountId,
        sourceType,
        sourceId: cleanId(order?.order_source_id),
        auctionId: cleanId(product?.auction_id),
        storage: cleanId(product.storage).toLowerCase(),
        storageId: cleanId(product.storage_id),
        productId: cleanId(product.product_id),
        ean: cleanId(product.ean),
        sku: cleanId(product.sku),
        name: cleanId(product.name),
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
        const payload = await callApi('getProductsData', {
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
          include_channels_media: true,
        });
        const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
        for (const productId of ids) {
          const ref = byProductId.get(String(productId));
          const product = products[productId] ?? products[String(productId)];
          if (!ref || !product) continue;
          found.add(ref.key);
          const entry = inventoryEntry(product, ref);
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


function exactText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pl-PL');
}

function normalizedNameTokens(value) {
  return exactText(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function canonicalNameSignature(value) {
  return normalizedNameTokens(value).sort().join('|');
}

function distinctiveNameFilters(value) {
  return [...new Set(normalizedNameTokens(value))]
    .filter((token) => token.length >= 6)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'pl-PL'))
    .slice(0, 3);
}

function inventoryListRows(payload) {
  const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
  if (Array.isArray(products)) {
    return products
      .map((row) => ({ id: cleanId(row?.id ?? row?.product_id), row }))
      .filter((item) => item.id);
  }
  return Object.entries(products)
    .map(([id, row]) => ({ id: cleanId(row?.id ?? row?.product_id ?? id), row }))
    .filter((item) => item.id);
}

function exactUnlinkedMatch(rows, ref, strategy) {
  if (strategy === 'ean') {
    // BaseLinker filter_ean also matches additional EANs that are not included
    // in the basic list row, so uniqueness of the server-filtered result is the
    // authoritative condition here.
    return rows.length === 1 ? rows[0] : null;
  }
  if (strategy === 'sku') {
    const wanted = exactText(ref.sku);
    const matches = rows.filter(({ row }) => exactText(row?.sku) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }
  const wanted = canonicalNameSignature(ref.name);
  const matches = rows.filter(({ row }) => canonicalNameSignature(row?.name) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

function storageDescriptor(ref) {
  const numericStorageId = Number(ref.storageId);
  const isInventory = ref.storage === 'db';
  return {
    key: `${ref.accountId}:${ref.storage}:${numericStorageId}`,
    numericStorageId,
    isInventory,
    apiStorageId: isInventory ? '' : `${ref.storage}_${numericStorageId}`,
    listMethod: isInventory ? 'getInventoryProductsList' : 'getProductsList',
    dataMethod: isInventory ? 'getInventoryProductsData' : 'getProductsData',
  };
}

function currentStorageSnapshot(descriptor) {
  const cached = storageCatalogSnapshots.get(descriptor.key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const snapshot = {
    rowsById: new Map(),
    nextPage: 1,
    complete: false,
    expiresAt: Date.now() + STORAGE_CATALOG_SNAPSHOT_TTL_MS,
  };
  storageCatalogSnapshots.set(descriptor.key, snapshot);
  return snapshot;
}

async function advanceStorageSnapshot(descriptor, snapshot, warnings, callApi, remainingRequests) {
  while (!snapshot.complete && snapshot.nextPage <= STORAGE_CATALOG_MAX_PAGES && remainingRequests() > 0) {
    const page = snapshot.nextPage;
    const params = descriptor.isInventory
      ? { inventory_id: descriptor.numericStorageId, page, include_variants: true, filter_sort: 'id ASC' }
      : { storage_id: descriptor.apiStorageId, page, filter_sort: 'id ASC' };
    let rows;
    try {
      rows = inventoryListRows(await callApi(descriptor.listMethod, params));
    } catch (error) {
      warnings.push({
        scope: descriptor.isInventory ? 'inventory_bulk_list' : 'external_bulk_list',
        storageId: descriptor.isInventory ? descriptor.numericStorageId : descriptor.apiStorageId,
        page,
        code: error?.code || error?.message || 'catalog_lookup_failed',
      });
      break;
    }
    for (const item of rows) snapshot.rowsById.set(item.id, item);
    snapshot.nextPage += 1;
    snapshot.expiresAt = Date.now() + STORAGE_CATALOG_SNAPSHOT_TTL_MS;
    if (rows.length < STORAGE_LIST_PAGE_SIZE) snapshot.complete = true;
  }
  return snapshot.complete;
}

function exactBulkUnlinkedMatch(rows, ref) {
  const candidates = [];
  if (ref.ean) {
    const wanted = exactText(ref.ean);
    const matches = rows.filter(({ row }) => exactText(row?.ean) === wanted);
    if (matches.length === 1) candidates.push(matches[0]);
  }
  if (ref.sku) {
    const wanted = exactText(ref.sku);
    const matches = rows.filter(({ row }) => exactText(row?.sku) === wanted);
    if (matches.length === 1) candidates.push(matches[0]);
  }
  if (ref.name) {
    const wanted = canonicalNameSignature(ref.name);
    const matches = rows.filter(({ row }) => canonicalNameSignature(row?.name) === wanted);
    if (matches.length === 1) candidates.push(matches[0]);
  }
  const ids = [...new Set(candidates.map((item) => item.id))];
  return ids.length === 1 ? candidates.find((item) => item.id === ids[0]) : null;
}

async function loadMatchedProductImages(descriptor, matches, productCatalog, warnings, callApi, remainingRequests) {
  const refsByProductId = new Map();
  for (const { ref, productId } of matches) {
    const id = cleanId(productId);
    if (!id) continue;
    if (!refsByProductId.has(id)) refsByProductId.set(id, []);
    refsByProductId.get(id).push(ref);
  }

  for (const ids of chunk(Array.from(refsByProductId.keys()))) {
    if (remainingRequests() <= 0) break;
    try {
      const payload = descriptor.isInventory
        ? await callApi(descriptor.dataMethod, {
          inventory_id: descriptor.numericStorageId,
          products: ids.map((id) => Number.isSafeInteger(Number(id)) ? Number(id) : id),
          include_channels_media: true,
        })
        : await callApi(descriptor.dataMethod, {
          storage_id: descriptor.apiStorageId,
          products: ids,
        });
      const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
      for (const productId of ids) {
        const product = products[productId] ?? products[String(productId)];
        if (!product) continue;
        for (const ref of refsByProductId.get(productId) || []) {
          const entry = descriptor.isInventory ? inventoryEntry(product, ref) : externalEntry(product);
          productCatalog[ref.key] = entry;
          setCached(ref.key, entry);
        }
      }
    } catch (error) {
      warnings.push({
        scope: descriptor.isInventory ? 'inventory_bulk_data' : 'external_bulk_data',
        storageId: descriptor.isInventory ? descriptor.numericStorageId : descriptor.apiStorageId,
        code: error?.code || error?.message || 'catalog_lookup_failed',
      });
    }
  }
}

async function resolveUnlinkedStorageRefs(refs, productCatalog, warnings, callApi, remainingRequests = () => Number.POSITIVE_INFINITY) {
  const candidates = refs
    .filter((ref) => !ref.productId && ['db', 'shop', 'warehouse'].includes(ref.storage))
    .filter((ref) => Number.isInteger(Number(ref.storageId)) && Number(ref.storageId) > 0)
    .filter((ref) => ref.ean || ref.sku || ref.name)
    .filter((ref) => normalizeImageUrls(productCatalog[ref.key]?.images).length === 0);
  if (!candidates.length) return;

  const groups = new Map();
  for (const ref of candidates) {
    const descriptor = storageDescriptor(ref);
    if (!groups.has(descriptor.key)) groups.set(descriptor.key, { descriptor, refs: [] });
    groups.get(descriptor.key).refs.push(ref);
  }

  for (const { descriptor, refs: storageRefs } of groups.values()) {
    const bulkMatchedKeys = new Set();
    if (storageRefs.length >= UNLINKED_BULK_SCAN_MIN_REFS && remainingRequests() > 0) {
      const snapshot = currentStorageSnapshot(descriptor);
      const complete = await advanceStorageSnapshot(descriptor, snapshot, warnings, callApi, remainingRequests);
      if (complete) {
        const rows = Array.from(snapshot.rowsById.values());
        const matches = [];
        for (const ref of storageRefs) {
          const match = exactBulkUnlinkedMatch(rows, ref);
          if (match) {
            matches.push({ ref, productId: match.id });
            bulkMatchedKeys.add(ref.key);
          } else if (!ref.ean) {
            // A complete exact-storage scan is authoritative for SKU/full-name
            // matching. EAN misses remain eligible for filter_ean because that
            // documented filter also searches additional EANs hidden from rows.
            productCatalog[ref.key] = { state: 'unlinked_storage_not_unique', images: [] };
          }
        }
        await loadMatchedProductImages(descriptor, matches, productCatalog, warnings, callApi, remainingRequests);
      }
    }

    const individualRefs = storageRefs
      .filter((ref) => !bulkMatchedKeys.has(ref.key))
      .filter((ref) => !productCatalog[ref.key])
      .slice(0, UNLINKED_STORAGE_MAX_PER_RUN);
    const matches = [];
    for (const ref of individualRefs) {
      if (remainingRequests() <= 0) break;
      const strategy = ref.ean ? 'ean' : (ref.sku ? 'sku' : 'name');
      const params = descriptor.isInventory
        ? { inventory_id: descriptor.numericStorageId, page: 1 }
        : { storage_id: descriptor.apiStorageId, page: 1 };
      if (strategy === 'ean') params.filter_ean = ref.ean;
      else if (strategy === 'sku') params.filter_sku = ref.sku;
      else params.filter_name = ref.name;

      let match = null;
      try {
        match = exactUnlinkedMatch(inventoryListRows(await callApi(descriptor.listMethod, params)), ref, strategy);
        if (!match && strategy === 'name') {
          for (const filterName of distinctiveNameFilters(ref.name)) {
            if (remainingRequests() <= 0) break;
            const fallbackParams = descriptor.isInventory
              ? { inventory_id: descriptor.numericStorageId, page: 1, filter_name: filterName }
              : { storage_id: descriptor.apiStorageId, page: 1, filter_name: filterName };
            match = exactUnlinkedMatch(inventoryListRows(await callApi(descriptor.listMethod, fallbackParams)), ref, strategy);
            if (match) break;
          }
        }
        if (!match) {
          productCatalog[ref.key] = { state: 'unlinked_storage_not_unique', images: [] };
          continue;
        }
        matches.push({ ref, productId: match.id });
      } catch (error) {
        warnings.push({
          scope: descriptor.isInventory ? 'inventory_unlinked_lookup' : 'external_unlinked_lookup',
          storageId: descriptor.isInventory ? descriptor.numericStorageId : descriptor.apiStorageId,
          code: error?.code || error?.message || 'catalog_lookup_failed',
        });
      }
    }
    await loadMatchedProductImages(descriptor, matches, productCatalog, warnings, callApi, remainingRequests);
  }
}

// BaseLinker does not expose an order-line photo or a documented offer-photo
// lookup by auction_id. Production resolution intentionally stays on the
// documented storage APIs above instead of scraping marketplace HTML.

/**
 * Enriches the order lines returned by the current getOrders read without
 * changing/persisting that upstream payload. The catalog is supplementary
 * current product data used for photos, features and packing context.
 */
async function fetchBaseLinkerProductCatalogSingle(orders, callApi, { maxRequests = Number.POSITIVE_INFINITY, linkedOnly = false } = {}) {
  let requestCount = 0;
  const budgetedCallApi = async (method, parameters) => {
    if (requestCount >= maxRequests) throw appError('baselinker_catalog_request_budget_exhausted');
    requestCount += 1;
    return callApi(method, parameters);
  };
  const refs = collectOrderProductRefs(orders);
  const productCatalog = {};
  const warnings = [];

  const productRefs = refs.filter((ref) => ref.productId);
  const internalRefs = productRefs.filter((ref) => ref.storage === 'db');
  const externalRefs = productRefs.filter((ref) => ref.storage === 'shop' || ref.storage === 'warehouse');
  const unsupportedRefs = productRefs.filter((ref) => !['db', 'shop', 'warehouse'].includes(ref.storage));

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

  if (!linkedOnly) {
    // Exact-source fallback for BaseLinker order rows whose product_id is blank.
    // The lookup stays inside the row's authoritative storage_id and is bounded
    // by both the per-run candidate cap and the shared BaseLinker request budget.
    await resolveUnlinkedStorageRefs(
      refs,
      productCatalog,
      warnings,
      budgetedCallApi,
      () => Math.max(0, maxRequests - requestCount),
    );
  }

  for (const ref of refs) {
    if (!productCatalog[ref.key]) productCatalog[ref.key] = { state: 'unresolved_exact_source', images: [] };
  }

  const resolved = Object.values(productCatalog).filter((entry) => entry?.state === 'resolved' && normalizeImageUrls(entry?.images).length).length;
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
  const rows = await BaseLinkerProductImageCache.find({
    productKey: { $in: refs.map((ref) => ref.key) },
    $or: [
      { resolverVersion: IMAGE_RESOLVER_VERSION },
      { state: 'resolved', imageUrl: { $nin: ['', null] } },
    ],
  })
    .select('productKey state imageUrl refreshedAt resolverVersion').lean();
  const byKey = new Map(rows.map((row) => [String(row.productKey), row]));
  const productCatalog = {};
  let resolved = 0;
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    if (!row) continue;
    const image = String(row.imageUrl || '').trim();
    productCatalog[ref.key] = { state: String(row.state || 'unresolved'), images: image ? [image] : [] };
    if (String(row.state || '') === 'resolved' && image) resolved += 1;
  }
  return {
    productCatalog,
    productCatalogStats: { requested: refs.length, resolved, unresolved: Math.max(0, refs.length - resolved), warnings: 0 },
    productCatalogWarnings: [],
  };
}

function attachProductImagesToOrders(orders, productCatalog = {}) {
  return (Array.isArray(orders) ? orders : []).map((order) => ({
    ...order,
    products: (Array.isArray(order?.products) ? order.products : []).map((product) => {
      const key = catalogKeyForOrderProduct(product, order?.baseLinkerAccountId, order?.order_source, order?.order_id);
      const imageUrl = key ? (normalizeImageUrls(productCatalog?.[key]?.images)[0] || '') : '';
      if (!imageUrl) return { ...product };
      return { ...product, image_url: imageUrl };
    }),
  }));
}

async function getOrdersWithCachedProductImages(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const catalog = await getCachedBaseLinkerProductCatalog(list);
  return {
    orders: attachProductImagesToOrders(list, catalog.productCatalog),
    productCatalog: catalog.productCatalog,
    productCatalogStats: catalog.productCatalogStats,
    productCatalogWarnings: catalog.productCatalogWarnings,
  };
}

async function warmBaseLinkerProductCatalog(orders, callApi, { maxRequests = 5, linkedOnly = false } = {}) {
  await ensureProductImageCacheReady();
  const list = Array.isArray(orders) ? orders : [];
  const refs = collectOrderProductRefs(list);
  const warmRefs = linkedOnly ? refs.filter((ref) => ref.productId) : refs;
  if (!warmRefs.length || typeof callApi !== 'function' || maxRequests <= 0) return getCachedBaseLinkerProductCatalog(list);
  const nowMs = Date.now();
  const freshRows = await BaseLinkerProductImageCache.find({
    productKey: { $in: warmRefs.map((ref) => ref.key) },
    $or: [
      { resolverVersion: IMAGE_RESOLVER_VERSION },
      { state: 'resolved', imageUrl: { $nin: ['', null] } },
    ],
  }).select('productKey state imageUrl refreshedAt resolverVersion').lean();
  const fresh = new Set(freshRows.filter((row) => {
    const refreshedAt = row?.refreshedAt ? new Date(row.refreshedAt).getTime() : 0;
    const hasImage = String(row?.imageUrl || '').trim().length > 0 && String(row?.state || '') === 'resolved';
    if (!hasImage && Number(row?.resolverVersion) !== IMAGE_RESOLVER_VERSION) return false;
    const ttl = hasImage ? PERSISTED_PRODUCT_CACHE_TTL_MS : NEGATIVE_PRODUCT_CACHE_TTL_MS;
    return refreshedAt > 0 && (nowMs - refreshedAt) < ttl;
  }).map((row) => String(row.productKey)));
  const staleKeys = new Set(warmRefs.filter((ref) => !fresh.has(ref.key)).map((ref) => ref.key));
  if (!staleKeys.size) return getCachedBaseLinkerProductCatalog(list);

  const missingOnlyOrders = list.map((order) => ({
    ...order,
    products: (Array.isArray(order?.products) ? order.products : []).filter((product) => {
      const key = catalogKeyForOrderProduct(product, order?.baseLinkerAccountId, order?.order_source, order?.order_id);
      return key && staleKeys.has(key) && (!linkedOnly || Boolean(String(product?.product_id || '').trim()));
    }),
  })).filter((order) => order.products.length);

  const freshResult = await fetchBaseLinkerProductCatalogSingle(missingOnlyOrders, callApi, { maxRequests, linkedOnly });
  const now = new Date();
  const writes = [];
  for (const [key, entry] of Object.entries(freshResult.productCatalog || {})) {
    const state = String(entry?.state || 'unresolved');
    // Transport/API errors are represented as warnings rather than entries, so
    // only deterministic results reach this cache. A transient failure is never
    // cached as a 24h successful lookup.
    const imageUrl = normalizeImageUrls(entry?.images)[0] || '';
    // unresolved_exact_source also represents rows that were not attempted yet
    // because the bounded request budget/candidate cap was exhausted. Persisting
    // that as a negative cache would suppress the next poll for an hour.
    if (state === 'unresolved_exact_source') continue;
    const accountId = String(key).split(':', 1)[0] || '';
    if (!accountId) continue;
    writes.push({ updateOne: {
      filter: { baseLinkerAccountId: accountId, productKey: key },
      update: { $set: { baseLinkerAccountId: accountId, productKey: key, resolverVersion: IMAGE_RESOLVER_VERSION, state, imageUrl, refreshedAt: now } },
      upsert: true,
    } });
  }
  if (writes.length) await BaseLinkerProductImageCache.bulkWrite(writes, { ordered: false });
  const cachedResult = await getCachedBaseLinkerProductCatalog(list);
  return {
    ...cachedResult,
    productCatalogWarnings: freshResult.productCatalogWarnings || [],
    productCatalogWarmStats: {
      requestCount: Number(freshResult.requestCount || 0),
      attempted: Number(freshResult.productCatalogStats?.requested || 0),
      resolvedThisRun: Number(freshResult.productCatalogStats?.resolved || 0),
      warnings: Number(freshResult.productCatalogStats?.warnings || 0),
    },
  };
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
  inventoryImageUrls,
  exactUnlinkedMatch,
  exactBulkUnlinkedMatch,
  collectOrderProductRefs,
  fetchBaseLinkerProductCatalog,
  getCachedBaseLinkerProductCatalog,
  attachProductImagesToOrders,
  getOrdersWithCachedProductImages,
  warmBaseLinkerProductCatalog,
};
