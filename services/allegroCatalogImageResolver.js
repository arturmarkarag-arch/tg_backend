'use strict';

const { listAllegroAccounts } = require('./allegroAccounts');
const { allegroRequest } = require('./allegroHttpClient');

const {
  TITLE_MATCH_THRESHOLD,
  normalizeImageUrls,
  normalizeName,
  scoreProductName,
  selectBestCatalogProduct,
} = require('./allegroCatalogImagePolicy');

const DEFAULT_MAX_REQUESTS = Math.min(
  150,
  Math.max(5, Number(process.env.ALLEGRO_BASELINKER_IMAGE_MAX_REQUESTS_PER_RUN) || 60),
);

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function offerImagesFromPayload(payload) {
  const direct = normalizeImageUrls(payload?.images);
  if (direct.length) return direct;
  const productImages = [];
  for (const row of Array.isArray(payload?.productSet) ? payload.productSet : []) {
    productImages.push(...normalizeImageUrls(row?.product?.images));
  }
  return normalizeImageUrls(productImages);
}

function saleOfferImagesFromPayload(payload, offerId = '') {
  const wanted = clean(offerId, 64);
  const offers = Array.isArray(payload?.offers) ? payload.offers : [];
  const offer = offers.find((row) => !wanted || clean(row?.id, 64) === wanted) || offers[0] || null;
  if (!offer) return [];
  return normalizeImageUrls([offer?.primaryImage, ...(Array.isArray(offer?.images) ? offer.images : [])]);
}

function upstreamStatus(error) {
  return Number(error?.status || error?.args?.upstreamStatus || error?.args?.status || 0) || 0;
}

async function catalogReaders() {
  const accounts = await listAllegroAccounts({ includeDisabled: false });
  return accounts.filter((account) => (
    account?.enabled === true
    && account?.authState === 'connected'
    && (account?.scopesKnown !== true || account?.capabilities?.saleOffersRead === true)
  ));
}

async function requestWithReaderAccounts(readers, options, budget) {
  let lastError = null;
  for (const reader of readers) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    budget.used += 1;
    try {
      const result = await allegroRequest(reader.accountId, {
        ...options,
        requireEnabled: true,
      });
      return { result, accountId: reader.accountId };
    } catch (error) {
      lastError = error;
      const status = upstreamStatus(error);
      // An offer can belong to another connected Allegro seller. Try the next
      // credential for auth/not-found cases; transient/rate errors still stop so
      // the shared Allegro HTTP policy remains authoritative.
      if (![401, 403, 404].includes(status)) throw error;
    }
  }
  if (lastError && ![401, 403, 404].includes(upstreamStatus(lastError))) throw lastError;
  return null;
}

function looksLikeGtin(value) {
  return /^\d{8,14}$/.test(clean(value, 32));
}

function looksLikeOfferId(value) {
  return /^\d{5,30}$/.test(clean(value, 64));
}

async function resolveOneRef(ref, readers, budget) {
  if (!readers.length || budget.remaining <= 0) return null;

  // Exact marketplace offer is the strongest source and is only attempted when
  // BaseLinker explicitly tells us this order line came from Allegro.
  if (readers.length === 1 && clean(ref?.sourceType, 80).toLowerCase() === 'allegro' && looksLikeOfferId(ref?.auctionId)) {
    const offerId = clean(ref.auctionId, 64);
    const exactList = await requestWithReaderAccounts(readers, {
      method: 'GET',
      path: '/sale/offers',
      query: { 'offer.id': offerId, limit: 1 },
      stage: 'baselinker_missing_image_offer_fallback',
      retryPolicy: 'safe',
      maxAttempts: 2,
    }, budget);
    if (exactList?.result?.payload) {
      const images = saleOfferImagesFromPayload(exactList.result.payload, offerId);
      if (images.length) return { state: 'resolved', images, source: 'allegro_offer_primary', confidence: 1 };
    }

    if (budget.remaining > 0) {
      const exact = await requestWithReaderAccounts(readers, {
        method: 'GET',
        path: `/sale/product-offers/${encodeURIComponent(offerId)}`,
        stage: 'baselinker_missing_image_offer_fallback_full',
        retryPolicy: 'safe',
        maxAttempts: 2,
      }, budget);
      if (exact?.result?.payload) {
        const images = offerImagesFromPayload(exact.result.payload);
        if (images.length) return { state: 'resolved', images, source: 'allegro_offer', confidence: 1 };
      }
    }
  }

  // GTIN/EAN is authoritative enough to accept the catalog search result
  // without fuzzy title matching.
  if (looksLikeGtin(ref?.ean) && budget.remaining > 0) {
    const gtin = await requestWithReaderAccounts(readers, {
      method: 'GET',
      path: '/sale/products',
      query: { phrase: clean(ref.ean, 32), mode: 'GTIN' },
      stage: 'baselinker_missing_image_gtin_fallback',
      retryPolicy: 'safe',
      maxAttempts: 2,
    }, budget);
    const selected = selectBestCatalogProduct(gtin?.result?.payload || {}, ref?.name || '', { exactIdentity: true });
    if (selected?.images?.length) {
      return { state: 'resolved', images: selected.images, source: 'allegro_gtin', confidence: selected.score };
    }
  }

  // Title lookup is a last resort. Never use the first result blindly: require
  // a high normalized token score so a wrong photo is not worse than no photo.
  const name = clean(ref?.name, 1000);
  if (name.length >= 4 && budget.remaining > 0) {
    const search = await requestWithReaderAccounts(readers, {
      method: 'GET',
      path: '/sale/products',
      query: { phrase: name },
      stage: 'baselinker_missing_image_title_fallback',
      retryPolicy: 'safe',
      maxAttempts: 2,
    }, budget);
    const selected = selectBestCatalogProduct(search?.result?.payload || {}, name, { exactIdentity: false });
    if (selected?.images?.length) {
      return { state: 'resolved', images: selected.images, source: 'allegro_title', confidence: selected.score };
    }
  }

  return { state: 'allegro_fallback_not_found', images: [], source: 'allegro_none', confidence: 0 };
}

async function resolveBaseLinkerMissingImages(refs, { maxRequests = DEFAULT_MAX_REQUESTS } = {}) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return { productCatalog: {}, requestCount: 0, readers: 0, resolved: 0, attempted: 0 };
  const readers = await catalogReaders();
  if (!readers.length) return { productCatalog: {}, requestCount: 0, readers: 0, resolved: 0, attempted: 0 };

  const budget = {
    remaining: Math.min(150, Math.max(1, Number(maxRequests) || DEFAULT_MAX_REQUESTS)),
    used: 0,
  };
  const productCatalog = {};
  let attempted = 0;
  let resolved = 0;

  // Deliberately sequential at the resolver layer. allegroRequest already has
  // per-account concurrency/rate limits and this prevents one BaseLinker sweep
  // from flooding the product-search Leaky Bucket with dozens of fuzzy lookups.
  for (const ref of list) {
    if (budget.remaining <= 0) break;
    attempted += 1;
    try {
      const entry = await resolveOneRef(ref, readers, budget);
      if (!entry) continue;
      productCatalog[ref.key] = entry;
      if (entry.state === 'resolved' && entry.images?.length) resolved += 1;
    } catch (error) {
      const status = upstreamStatus(error);
      // Transient/rate failures are not negative-cached. The next scheduler pass
      // may retry after the HTTP client's backoff window.
      if ([408, 425, 429, 500, 502, 503, 504].includes(status) || !status) break;
      productCatalog[ref.key] = { state: 'allegro_fallback_not_found', images: [], source: 'allegro_error', confidence: 0 };
    }
  }

  return {
    productCatalog,
    requestCount: budget.used,
    readers: readers.length,
    resolved,
    attempted,
  };
}

module.exports = {
  DEFAULT_MAX_REQUESTS,
  TITLE_MATCH_THRESHOLD,
  normalizeName,
  scoreProductName,
  selectBestCatalogProduct,
  resolveBaseLinkerMissingImages,
};
