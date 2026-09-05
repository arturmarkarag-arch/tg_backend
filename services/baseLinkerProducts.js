const { callBaseLinker } = require('./baseLinkerClient');

const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_CHUNK_SIZE = 100;
const productCache = new Map();
let inventoriesCache = null;
let inventoriesCacheExpiresAt = 0;
let inventoriesInFlight = null;

function cleanId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function catalogKeyForOrderProduct(product) {
  const storage = cleanId(product?.storage).toLowerCase();
  const storageId = cleanId(product?.storage_id);
  const productId = cleanId(product?.product_id);
  if (!storage || !productId) return null;
  return `${storage}:${storageId}:${productId}`;
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

async function getInventories(callApi) {
  const now = Date.now();
  if (callApi === callBaseLinker && inventoriesCache && now < inventoriesCacheExpiresAt) return inventoriesCache;
  if (callApi === callBaseLinker && inventoriesInFlight) return inventoriesInFlight;

  const load = async () => {
    const payload = await callApi('getInventories', {});
    const inventories = Array.isArray(payload?.inventories) ? payload.inventories : [];
    if (callApi === callBaseLinker) {
      inventoriesCache = inventories;
      inventoriesCacheExpiresAt = Date.now() + PRODUCT_CACHE_TTL_MS;
    }
    return inventories;
  };

  if (callApi !== callBaseLinker) return load();
  inventoriesInFlight = load();
  try {
    return await inventoriesInFlight;
  } finally {
    inventoriesInFlight = null;
  }
}

function collectOrderProductRefs(orders) {
  const refsByKey = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const product of Array.isArray(order?.products) ? order.products : []) {
      const key = catalogKeyForOrderProduct(product);
      if (!key || refsByKey.has(key)) continue;
      refsByKey.set(key, {
        key,
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

async function resolveUnmappedInventoryRefs(refs, productCatalog, warnings, callApi) {
  if (!refs.length) return;

  let inventories;
  try {
    inventories = await getInventories(callApi);
  } catch (error) {
    warnings.push({ scope: 'inventories', code: error?.code || error?.message || 'inventory_list_failed' });
    return;
  }

  const inventoryIds = inventories
    .map((item) => Number(item?.inventory_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!inventoryIds.length) return;

  const wantedIds = Array.from(new Set(refs.map((ref) => ref.productId)));
  const matchesByProductId = new Map(wantedIds.map((id) => [id, []]));

  for (const inventoryId of inventoryIds) {
    for (const ids of chunk(wantedIds)) {
      try {
        const payload = await callApi('getInventoryProductsData', {
          inventory_id: inventoryId,
          products: ids.map((id) => Number.isSafeInteger(Number(id)) ? Number(id) : id),
          include_channels_media: false,
        });
        const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
        for (const productId of ids) {
          const product = products[productId] ?? products[String(productId)];
          if (product) matchesByProductId.get(String(productId))?.push({ inventoryId, product });
        }
      } catch (error) {
        warnings.push({
          scope: 'inventory_fallback',
          inventoryId,
          code: error?.code || error?.message || 'catalog_lookup_failed',
        });
      }
    }
  }

  for (const ref of refs) {
    const matches = matchesByProductId.get(ref.productId) || [];
    if (matches.length === 1) {
      const match = matches[0];
      const entry = inventoryEntry(match.product);
      productCatalog[ref.key] = entry;
      setCached(ref.key, entry);
    } else if (matches.length > 1) {
      productCatalog[ref.key] = { state: 'ambiguous', images: [] };
    }
  }
}

/**
 * Enriches order lines with product-catalog data without changing the raw
 * getOrders payload. getOrders is the immutable order snapshot (quantity,
 * price, chosen variant, etc.); this catalog is supplementary current product
 * data used for photos, features and packing context.
 */
async function fetchBaseLinkerProductCatalog(orders, callApi = callBaseLinker) {
  const refs = collectOrderProductRefs(orders);
  const productCatalog = {};
  const warnings = [];

  const internalRefs = refs.filter((ref) => ref.storage === 'db');
  const externalRefs = refs.filter((ref) => ref.storage === 'shop' || ref.storage === 'warehouse');
  const unsupportedRefs = refs.filter((ref) => !['db', 'shop', 'warehouse'].includes(ref.storage));

  await resolveExternalRefs(externalRefs, productCatalog, warnings, callApi);

  const unresolvedInternal = [];
  await tryDirectInventoryRefs(internalRefs, productCatalog, unresolvedInternal, warnings, callApi);
  await resolveUnmappedInventoryRefs(unresolvedInternal, productCatalog, warnings, callApi);

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
  };
}

module.exports = {
  catalogKeyForOrderProduct,
  normalizeImageUrls,
  collectOrderProductRefs,
  fetchBaseLinkerProductCatalog,
};
