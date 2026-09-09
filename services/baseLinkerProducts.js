const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');
const { productKey } = require('./baseLinkerIdentity');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_PRODUCT_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.BASELINKER_PRODUCT_NEGATIVE_CACHE_TTL_MS) || (60 * 60 * 1000));
const PERSISTED_PRODUCT_CACHE_TTL_MS = Math.max(PRODUCT_CACHE_TTL_MS, Number(process.env.BASELINKER_PRODUCT_CACHE_TTL_MS) || (24 * 60 * 60 * 1000));
const LOOKUP_CHUNK_SIZE = 100;
const IMAGE_RESOLVER_VERSION = 5;
const ALLEGRO_OFFER_TIMEOUT_MS = Math.min(15000, Math.max(2000, Number(process.env.BASELINKER_ALLEGRO_IMAGE_TIMEOUT_MS) || 6000));
const ALLEGRO_OFFER_MAX_PER_RUN = Math.min(20, Math.max(1, Number(process.env.BASELINKER_ALLEGRO_IMAGE_MAX_PER_RUN) || 8));
const UNLINKED_STORAGE_MAX_PER_RUN = Math.min(10, Math.max(1, Number(process.env.BASELINKER_UNLINKED_STORAGE_MAX_PER_RUN || process.env.BASELINKER_UNLINKED_INVENTORY_MAX_PER_RUN) || 4));
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

async function resolveUnlinkedStorageRefs(refs, productCatalog, warnings, callApi) {
  const candidates = refs
    .filter((ref) => !ref.productId && ['db', 'shop', 'warehouse'].includes(ref.storage))
    .filter((ref) => Number.isInteger(Number(ref.storageId)) && Number(ref.storageId) > 0)
    .filter((ref) => ref.ean || ref.sku || ref.name)
    .filter((ref) => normalizeImageUrls(productCatalog[ref.key]?.images).length === 0)
    .slice(0, UNLINKED_STORAGE_MAX_PER_RUN);
  if (!candidates.length) return;

  const resolvedByStorage = new Map();
  for (const ref of candidates) {
    const numericStorageId = Number(ref.storageId);
    const storageKey = `${ref.storage}:${numericStorageId}`;
    const isInventory = ref.storage === 'db';
    const apiStorageId = isInventory ? '' : `${ref.storage}_${numericStorageId}`;
    const method = isInventory ? 'getInventoryProductsList' : 'getProductsList';
    const strategy = ref.ean ? 'ean' : (ref.sku ? 'sku' : 'name');
    const params = isInventory
      ? { inventory_id: numericStorageId, page: 1 }
      : { storage_id: apiStorageId, page: 1 };
    if (strategy === 'ean') params.filter_ean = ref.ean;
    else if (strategy === 'sku') params.filter_sku = ref.sku;
    else params.filter_name = ref.name;

    try {
      const payload = await callApi(method, params);
      let match = exactUnlinkedMatch(inventoryListRows(payload), ref, strategy);

      // Name search is only a deterministic fallback inside the exact source
      // storage. We still require one row whose complete normalized token set
      // equals the order line, so this never becomes cross-catalog guessing.
      if (!match && strategy === 'name') {
        for (const filterName of distinctiveNameFilters(ref.name)) {
          const fallbackParams = isInventory
            ? { inventory_id: numericStorageId, page: 1, filter_name: filterName }
            : { storage_id: apiStorageId, page: 1, filter_name: filterName };
          const fallbackPayload = await callApi(method, fallbackParams);
          match = exactUnlinkedMatch(inventoryListRows(fallbackPayload), ref, strategy);
          if (match) break;
        }
      }

      if (!match) {
        if (!productCatalog[ref.key]) productCatalog[ref.key] = { state: 'unlinked_storage_not_unique', images: [] };
        continue;
      }
      if (!resolvedByStorage.has(storageKey)) resolvedByStorage.set(storageKey, { ref, matches: [] });
      resolvedByStorage.get(storageKey).matches.push({ ref, productId: match.id });
    } catch (error) {
      warnings.push({
        scope: isInventory ? 'inventory_unlinked_lookup' : 'external_unlinked_lookup',
        storageId: isInventory ? numericStorageId : apiStorageId,
        code: error?.code || error?.message || 'catalog_lookup_failed',
      });
    }
  }

  for (const { ref: storageRef, matches } of resolvedByStorage.values()) {
    const isInventory = storageRef.storage === 'db';
    const numericStorageId = Number(storageRef.storageId);
    const apiStorageId = isInventory ? '' : `${storageRef.storage}_${numericStorageId}`;
    for (const batch of chunk(matches)) {
      const ids = batch.map((item) => Number.isSafeInteger(Number(item.productId)) ? Number(item.productId) : item.productId);
      try {
        const payload = isInventory
          ? await callApi('getInventoryProductsData', {
            inventory_id: numericStorageId,
            products: ids,
            include_channels_media: true,
          })
          : await callApi('getProductsData', {
            storage_id: apiStorageId,
            products: ids,
          });
        const products = payload?.products && typeof payload.products === 'object' ? payload.products : {};
        for (const item of batch) {
          const product = products[item.productId] ?? products[String(item.productId)];
          if (!product) continue;
          const entry = isInventory ? inventoryEntry(product, item.ref) : externalEntry(product);
          productCatalog[item.ref.key] = entry;
          setCached(item.ref.key, entry);
        }
      } catch (error) {
        warnings.push({
          scope: isInventory ? 'inventory_unlinked_data' : 'external_unlinked_data',
          storageId: isInventory ? numericStorageId : apiStorageId,
          code: error?.code || error?.message || 'catalog_lookup_failed',
        });
      }
    }
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function safeAllegroImageUrl(value) {
  const raw = decodeHtmlEntities(value).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    if (host !== 'allegroimg.com' && !host.endsWith('.allegroimg.com')) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function extractAllegroImageFromHtml(html) {
  const source = String(html || '');
  const metaPatterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
  ];
  for (const pattern of metaPatterns) {
    const match = source.match(pattern);
    const url = safeAllegroImageUrl(match?.[1]);
    if (url) return url;
  }
  return '';
}

async function fetchAllegroOfferImage(auctionId) {
  const id = cleanId(auctionId);
  if (!/^\d{5,30}$/.test(id)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALLEGRO_OFFER_TIMEOUT_MS);
  try {
    // The slug is deliberately synthetic: Allegro identifies the concrete
    // listing by the numeric suffix. No product name/SKU matching participates.
    for (const target of [`https://allegro.pl/oferta/x-${encodeURIComponent(id)}`, `https://allegro.pl/oferta/${encodeURIComponent(id)}`]) {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (compatible; WarehouseProductImageResolver/1.0)',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const image = extractAllegroImageFromHtml(html);
      if (image) return image;
    }
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAllegroOfferRefs(refs, productCatalog, warnings, imageLoader = fetchAllegroOfferImage) {
  const candidates = refs
    .filter((ref) => ref.sourceType === 'allegro' && /^\d{5,30}$/.test(ref.auctionId))
    .filter((ref) => normalizeImageUrls(productCatalog[ref.key]?.images).length === 0)
    .slice(0, ALLEGRO_OFFER_MAX_PER_RUN);

  for (const ref of candidates) {
    const cached = getCached(ref.key);
    if (cached && normalizeImageUrls(cached.images).length) {
      productCatalog[ref.key] = cached;
      continue;
    }
    try {
      const imageUrl = await imageLoader(ref.auctionId);
      if (!imageUrl) {
        if (!productCatalog[ref.key]) productCatalog[ref.key] = { state: 'offer_no_image', images: [] };
        continue;
      }
      const entry = { state: 'resolved', images: [imageUrl] };
      productCatalog[ref.key] = entry;
      setCached(ref.key, entry);
    } catch (error) {
      warnings.push({
        scope: 'allegro_offer_image',
        auctionId: ref.auctionId,
        code: error?.name === 'AbortError' ? 'offer_image_timeout' : (error?.code || error?.message || 'offer_image_lookup_failed'),
      });
    }
  }
}

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
    await resolveUnlinkedStorageRefs(refs, productCatalog, warnings, budgetedCallApi);

    // Allegro listing fallback uses the exact auction_id and consumes no
    // BaseLinker API budget. It covers unlinked marketplace rows when the
    // catalog binding is missing or has no usable image.
    await resolveAllegroOfferRefs(refs, productCatalog, warnings);
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
  const rows = await BaseLinkerProductImageCache.find({ productKey: { $in: refs.map((ref) => ref.key) }, resolverVersion: IMAGE_RESOLVER_VERSION })
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
    resolverVersion: IMAGE_RESOLVER_VERSION,
  }).select('productKey state imageUrl refreshedAt resolverVersion').lean();
  const fresh = new Set(freshRows.filter((row) => {
    const refreshedAt = row?.refreshedAt ? new Date(row.refreshedAt).getTime() : 0;
    const hasImage = String(row?.imageUrl || '').trim().length > 0 && String(row?.state || '') === 'resolved';
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
  inventoryImageUrls,
  exactUnlinkedMatch,
  extractAllegroImageFromHtml,
  fetchAllegroOfferImage,
  collectOrderProductRefs,
  fetchBaseLinkerProductCatalog,
  getCachedBaseLinkerProductCatalog,
  attachProductImagesToOrders,
  getOrdersWithCachedProductImages,
  warmBaseLinkerProductCatalog,
};
