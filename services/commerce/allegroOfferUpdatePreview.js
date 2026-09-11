'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { getCatalogProduct } = require('./catalog');
const { buildDraftPayload, stableExternalKey, requestHash } = require('./allegroDraftOffer');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeForHash(value) {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = normalizeForHash(value[key]);
  return out;
}

function sameJson(a, b) {
  return JSON.stringify(normalizeForHash(a ?? null)) === JSON.stringify(normalizeForHash(b ?? null));
}

function imageUrls(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => text(typeof item === 'string' ? item : item?.url, 2500))
    .filter(Boolean)
    .slice(0, 16);
}

function normalizedParameters(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((row) => ({
      id: text(row?.id, 100),
      valuesIds: (Array.isArray(row?.valuesIds) ? row.valuesIds : []).map((v) => text(v, 300)).filter(Boolean).sort(),
      values: (Array.isArray(row?.values) ? row.values : []).map((v) => text(v, 1000)).filter(Boolean).sort(),
      rangeValue: row?.rangeValue ? {
        from: text(row.rangeValue.from, 300),
        to: text(row.rangeValue.to, 300),
      } : null,
    }))
    .filter((row) => row.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}


function parameterSubsetMatches(expected, actual) {
  const actualById = new Map((Array.isArray(actual) ? actual : []).map((row) => [row.id, row]));
  return (Array.isArray(expected) ? expected : []).every((row) => {
    const current = actualById.get(row.id);
    return current && sameJson(row, current);
  });
}

function firstProduct(offer = {}) {
  const set = Array.isArray(offer?.productSet) ? offer.productSet : [];
  return set[0]?.product && typeof set[0].product === 'object' ? set[0].product : {};
}

function desiredSnapshot(payload = {}) {
  const product = firstProduct(payload);
  return {
    name: text(payload.name, 300),
    description: payload.description || null,
    images: imageUrls(payload.images),
    offerParameters: normalizedParameters(payload.parameters),
    mapping: {
      categoryId: text(payload?.category?.id, 100),
      catalogProductId: text(product?.id, 200),
      productParameters: normalizedParameters(product?.parameters),
    },
    price: {
      amount: text(payload?.sellingMode?.price?.amount, 40),
      currency: text(payload?.sellingMode?.price?.currency, 10).toUpperCase(),
    },
    stock: { available: Math.max(0, Math.floor(number(payload?.stock?.available, 0))) },
  };
}

function actualSnapshot(offer = {}) {
  const product = firstProduct(offer);
  return {
    name: text(offer.name, 300),
    description: offer.description || null,
    images: imageUrls(offer.images),
    offerParameters: normalizedParameters(offer.parameters),
    mapping: {
      categoryId: text(offer?.category?.id, 100),
      catalogProductId: text(product?.id, 200),
      productParameters: normalizedParameters(product?.parameters),
    },
    price: {
      amount: text(offer?.sellingMode?.price?.amount, 40),
      currency: text(offer?.sellingMode?.price?.currency, 10).toUpperCase(),
    },
    stock: { available: Math.max(0, Math.floor(number(offer?.stock?.available, 0))) },
    publicationStatus: text(offer?.publication?.status, 40).toUpperCase(),
  };
}

function change(field, label, expected, actual, group, nextStage, { blocking = false, note = '' } = {}) {
  return {
    field,
    label,
    group,
    nextStage,
    blocking,
    expected,
    actual,
    note: text(note, 1200),
  };
}

function compareSnapshots(desired, actual) {
  const contentChanges = [];
  const mappingChanges = [];
  const deferredChanges = [];
  const contentPatch = {};

  if (desired.name && desired.name !== actual.name) {
    contentChanges.push(change('name', 'Назва', desired.name, actual.name, 'content', '3D.4.1'));
    contentPatch.name = desired.name;
  }

  // Do not clear description implicitly. Empty local description means "not managed"
  // until the operator deliberately provides one in Commerce Catalog/ChannelListing.
  if (desired.description && !sameJson(desired.description, actual.description)) {
    contentChanges.push(change('description', 'Опис', desired.description, actual.description, 'content', '3D.4.1'));
    contentPatch.description = desired.description;
  }

  // Arrays are all-or-nothing in Allegro PATCH (RFC7396), therefore a future apply
  // must send the complete desired image array, never a single appended image.
  if (desired.images.length && !sameJson(desired.images, actual.images)) {
    contentChanges.push(change('images', 'Фото', desired.images, actual.images, 'content', '3D.4.1', {
      note: 'PATCH images замінює всю галерею; apply має передати повний масив.',
    }));
    contentPatch.images = desired.images;
  }

  // Offer parameters are intentionally previewed but not included in the first
  // safe content PATCH. Their semantics vary by category and Allegro validates the
  // whole offer for non-price/stock edits, so Stage 3D.4.1 will gate them separately.
  if (desired.offerParameters.length && !parameterSubsetMatches(desired.offerParameters, actual.offerParameters)) {
    mappingChanges.push(change('parameters', 'Параметри offer', desired.offerParameters, actual.offerParameters, 'mapping', '3D.4.1', {
      blocking: true,
      note: 'Потрібна повторна перевірка category parameters перед write.',
    }));
  }

  if (desired.mapping.categoryId !== actual.mapping.categoryId) {
    mappingChanges.push(change('category.id', 'Категорія', desired.mapping.categoryId, actual.mapping.categoryId, 'mapping', '3B', {
      blocking: true,
      note: 'Категорію Allegro можна змінити лише протягом обмеженого часу після першої публікації; автоматично не синхронізуємо.',
    }));
  }
  if (desired.mapping.catalogProductId && desired.mapping.catalogProductId !== actual.mapping.catalogProductId) {
    mappingChanges.push(change('productSet[0].product.id', 'Продукт Каталогу Allegro', desired.mapping.catalogProductId, actual.mapping.catalogProductId, 'mapping', '3B', {
      blocking: true,
      note: 'Зміна product.id може також змінити опис, фото, категорію та product parameters; потрібен окремий remap flow.',
    }));
  }
  if (desired.mapping.productParameters.length && !parameterSubsetMatches(desired.mapping.productParameters, actual.mapping.productParameters)) {
    mappingChanges.push(change('productSet[0].product.parameters', 'Параметри продукту', desired.mapping.productParameters, actual.mapping.productParameters, 'mapping', '3B', {
      blocking: true,
      note: 'Product parameters і trusted catalog data не синхронізуємо сліпим content PATCH.',
    }));
  }

  if (!sameJson(desired.price, actual.price)) {
    deferredChanges.push(change('sellingMode.price', 'Ціна', desired.price, actual.price, 'price', '3D.5', {
      note: 'Ціна піде окремим спеціалізованим sync, а не через content update.',
    }));
  }
  if (!sameJson(desired.stock, actual.stock)) {
    deferredChanges.push(change('stock.available', 'Залишок', desired.stock, actual.stock, 'stock', '3D.6', {
      note: 'Stock піде окремим спеціалізованим sync, а не через content update.',
    }));
  }

  return {
    contentChanges,
    mappingChanges,
    deferredChanges,
    contentPatch,
    contentReadyForApply: mappingChanges.filter((row) => row.blocking).length === 0 && Object.keys(contentPatch).length > 0,
  };
}

function contentPatchIssues(patch = {}, offer = {}) {
  const actual = actualSnapshot(offer);
  const issues = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'name') && text(patch.name, 300) !== actual.name) {
    issues.push({ code: 'name_mismatch', field: 'name', expected: text(patch.name, 300), actual: actual.name, message: 'Назва в Allegro не збігається з content PATCH.' });
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description') && !sameJson(patch.description, actual.description)) {
    issues.push({ code: 'description_mismatch', field: 'description', expected: patch.description, actual: actual.description, message: 'Опис в Allegro не збігається з content PATCH.' });
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'images')) {
    const expectedImages = imageUrls(patch.images);
    if (!sameJson(expectedImages, actual.images)) {
      issues.push({ code: 'images_mismatch', field: 'images', expected: expectedImages, actual: actual.images, message: 'Галерея фото в Allegro не збігається з повним масивом content PATCH.' });
    }
  }
  return issues;
}

async function requireReadAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true) {
    throw appError('commerce_allegro_update_preview_scope_required');
  }
  return account;
}

async function getListing(productId, accountId) {
  const listing = await ChannelListing.findOne({ commerceProductId: productId, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  if (!text(listing.externalId, 200)) throw appError('commerce_allegro_draft_not_bound');
  return listing;
}

async function persistPreview(listing, preview) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  providerData.allegro = {
    ...(providerData.allegro || {}),
    updatePreview: preview,
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

async function previewAllegroOfferUpdate(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireReadAccount(accountId);
  const [product, listing] = await Promise.all([
    getCatalogProduct(productId),
    getListing(productId, accountId),
  ]);

  const payload = buildDraftPayload({ product, listing, externalKey: stableExternalKey(listing._id) });
  const desired = desiredSnapshot(payload);
  const desiredHash = requestHash({
    name: desired.name,
    description: desired.description,
    images: desired.images,
    offerParameters: desired.offerParameters,
    mapping: desired.mapping,
  });

  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_publication_update_preview',
  });
  const offer = result.payload || {};
  if (!text(offer.id, 200)) throw appError('commerce_allegro_update_preview_response_invalid');

  const actual = actualSnapshot(offer);
  const compared = compareSnapshots(desired, actual);
  const preview = {
    stage: '3D.4A',
    readOnlyUpstream: true,
    checkedAt: new Date().toISOString(),
    desiredHash,
    publicationStatus: actual.publicationStatus,
    contentReadyForApply: actual.publicationStatus === 'ACTIVE' && compared.contentReadyForApply,
    contentChangeCount: compared.contentChanges.length,
    mappingChangeCount: compared.mappingChanges.length,
    deferredChangeCount: compared.deferredChanges.length,
    contentChanges: compared.contentChanges,
    mappingChanges: compared.mappingChanges,
    deferredChanges: compared.deferredChanges,
    contentPatch: compared.contentPatch,
    traceId: text(result.traceId, 256),
    requestId: text(result.requestId, 128),
  };

  await persistPreview(listing, preview);

  return {
    ...preview,
    providerCalls: 1,
    productId,
    accountId,
    listingId: String(listing._id),
    offerId: text(offer.id, 200),
  };
}

module.exports = {
  actualSnapshot,
  compareSnapshots,
  contentPatchIssues,
  desiredSnapshot,
  previewAllegroOfferUpdate,
};
