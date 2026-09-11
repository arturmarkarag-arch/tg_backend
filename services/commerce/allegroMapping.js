'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { getCatalogProduct } = require('./catalog');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const MAX_CANDIDATES = 12;
const MAX_PARAMETER_VALUES = 40;
const KNOWN_GTIN_PARAMETER_IDS = new Set(['225693', '245669', '245673']);

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function bool(value) {
  return value === true;
}

function isLikelyGtin(value) {
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text(value, 120).replace(/\s+/g, ''));
}

function normalizeParameterValue(raw = {}) {
  const valuesIds = [...new Set((Array.isArray(raw.valuesIds) ? raw.valuesIds : [])
    .map((value) => text(value, 200)).filter(Boolean))].slice(0, MAX_PARAMETER_VALUES);
  const values = (Array.isArray(raw.values) ? raw.values : [])
    .map((value) => text(value, 1000)).filter(Boolean).slice(0, MAX_PARAMETER_VALUES);
  let rangeValue = null;
  if (raw.rangeValue && typeof raw.rangeValue === 'object' && !Array.isArray(raw.rangeValue)) {
    const from = text(raw.rangeValue.from, 200);
    const to = text(raw.rangeValue.to, 200);
    if (from || to) rangeValue = { from: from || null, to: to || null };
  }
  return { valuesIds, values, rangeValue };
}

function hasParameterValue(raw) {
  const value = normalizeParameterValue(raw);
  return value.valuesIds.length > 0 || value.values.length > 0 || Boolean(value.rangeValue?.from || value.rangeValue?.to);
}

function mapParameterValues(rows) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const id = text(row?.id, 100);
    if (!id) continue;
    map.set(id, normalizeParameterValue(row));
  }
  return map;
}

function dictionaryChoices(parameter) {
  const raw = Array.isArray(parameter?.dictionary)
    ? parameter.dictionary
    : (Array.isArray(parameter?.values) && parameter.values.some((item) => item && typeof item === 'object') ? parameter.values : []);
  return raw.slice(0, 500).map((item) => ({
    id: text(item?.id ?? item?.valueId, 200),
    value: text(item?.value ?? item?.name, 500),
    dependsOnValueIds: (Array.isArray(item?.dependsOnValueIds) ? item.dependsOnValueIds : []).map((value) => text(value, 200)).filter(Boolean).slice(0, 50),
  })).filter((item) => item.id || item.value);
}

function safeConditions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ['parametersWithValue', 'parametersWithoutValue']) {
    if (!Array.isArray(raw[key])) continue;
    out[key] = raw[key].slice(0, 50).map((item) => ({
      id: text(item?.id, 100),
      oneOfValueIds: (Array.isArray(item?.oneOfValueIds) ? item.oneOfValueIds : []).map((value) => text(value, 200)).filter(Boolean).slice(0, 50),
    })).filter((item) => item.id);
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeParameter(parameter, currentValue) {
  const restrictions = parameter?.restrictions && typeof parameter.restrictions === 'object'
    ? parameter.restrictions
    : {};
  const options = parameter?.options && typeof parameter.options === 'object'
    ? parameter.options
    : {};
  return {
    id: text(parameter?.id, 100),
    name: text(parameter?.name, 500),
    type: text(parameter?.type, 80).toLowerCase(),
    required: bool(parameter?.required),
    requiredForProduct: bool(parameter?.requiredForProduct),
    describesProduct: bool(options.describesProduct),
    unit: text(parameter?.unit, 80),
    choices: dictionaryChoices(parameter),
    options: {
      ambiguousValueId: text(options.ambiguousValueId, 200),
      dependsOnParameterId: text(options.dependsOnParameterId, 100),
      customValuesEnabled: bool(options.customValuesEnabled),
    },
    restrictions: {
      multipleChoices: bool(restrictions.multipleChoices),
      range: bool(restrictions.range),
      min: Number.isFinite(Number(restrictions.min)) ? Number(restrictions.min) : null,
      max: Number.isFinite(Number(restrictions.max)) ? Number(restrictions.max) : null,
      precision: Number.isFinite(Number(restrictions.precision)) ? Number(restrictions.precision) : null,
      minLength: Number.isFinite(Number(restrictions.minLength)) ? Number(restrictions.minLength) : null,
      maxLength: Number.isFinite(Number(restrictions.maxLength)) ? Number(restrictions.maxLength) : null,
    },
    requiredIf: safeConditions(parameter?.requiredIf),
    displayedIf: safeConditions(parameter?.displayedIf),
    value: normalizeParameterValue(currentValue),
  };
}

function flattenMatchingCategory(row) {
  const path = [];
  let current = row;
  let guard = 0;
  while (current && guard < 12) {
    if (text(current.name, 500)) path.unshift(text(current.name, 500));
    current = current.parent;
    guard += 1;
  }
  return { id: text(row?.id, 100), name: text(row?.name, 500), path };
}

function sanitizeProductCandidate(row) {
  const category = row?.category || {};
  return {
    id: text(row?.id, 120),
    name: text(row?.name, 500),
    category: {
      id: text(category?.id, 100),
      path: (Array.isArray(category?.path) ? category.path : []).map((item) => text(item?.name || item, 500)).filter(Boolean).slice(0, 20),
      similar: (Array.isArray(category?.similar) ? category.similar : []).slice(0, 20).map((item) => ({
        id: text(item?.id, 100),
        path: (Array.isArray(item?.path) ? item.path : []).map((entry) => text(entry?.name || entry, 500)).filter(Boolean).slice(0, 20),
      })),
    },
    imageUrl: text(row?.images?.[0]?.url, 2000),
    parameters: (Array.isArray(row?.parameters) ? row.parameters : []).slice(0, 200).map((item) => ({
      id: text(item?.id, 100),
      name: text(item?.name, 500),
      ...normalizeParameterValue(item),
    })),
  };
}

async function requireAllegroMappingAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (matrix.scopesKnown && matrix.capabilities.saleOffersRead !== true) {
    throw appError('commerce_allegro_mapping_scope_required');
  }
  return { account, matrix };
}

async function getListing(productId, accountId) {
  return ChannelListing.findOne({ commerceProductId: productId, provider: 'allegro', accountId }).lean();
}

async function allegroRead(accountId, options, counter) {
  const result = await allegroRequest(accountId, {
    method: 'GET',
    retryPolicy: 'safe',
    maxAttempts: 3,
    acceptLanguage: 'pl-PL',
    ...options,
  });
  counter.count += 1;
  return result.payload || {};
}

async function findProductsByGtin(accountId, gtin, counter) {
  if (!isLikelyGtin(gtin)) return [];
  const payload = await allegroRead(accountId, {
    path: '/sale/products',
    query: { phrase: text(gtin, 120), mode: 'GTIN', language: 'pl-PL' },
    stage: 'commerce_publication_mapping_products',
  }, counter);
  return (Array.isArray(payload.products) ? payload.products : []).slice(0, MAX_CANDIDATES).map(sanitizeProductCandidate);
}

async function getProductDetail(accountId, productId, counter) {
  const id = text(productId, 160);
  if (!id) return null;
  const payload = await allegroRead(accountId, {
    path: `/sale/products/${encodeURIComponent(id)}`,
    stage: 'commerce_publication_mapping_product_detail',
  }, counter);
  return sanitizeProductCandidate(payload);
}

async function getCategoryDetail(accountId, categoryId, counter) {
  const id = text(categoryId, 100);
  if (!id) return null;
  const payload = await allegroRead(accountId, {
    path: `/sale/categories/${encodeURIComponent(id)}`,
    stage: 'commerce_publication_mapping_category',
  }, counter);
  return {
    id: text(payload?.id, 100),
    name: text(payload?.name, 500),
    leaf: payload?.leaf === true,
    parentId: text(payload?.parent?.id, 100),
    options: {
      offersWithProductPublicationEnabled: payload?.options?.offersWithProductPublicationEnabled !== false,
      productCreationEnabled: payload?.options?.productCreationEnabled === true,
      advertisement: payload?.options?.advertisement === true,
    },
  };
}

async function getCategoryParameters(accountId, categoryId, counter) {
  const payload = await allegroRead(accountId, {
    path: `/sale/categories/${encodeURIComponent(text(categoryId, 100))}/parameters`,
    stage: 'commerce_publication_mapping_parameters',
  }, counter);
  return Array.isArray(payload.parameters) ? payload.parameters.slice(0, 1000) : [];
}

async function matchingCategories(accountId, phrase, counter) {
  const name = text(phrase, 1024);
  if (!name) return [];
  const payload = await allegroRead(accountId, {
    path: '/sale/matching-categories',
    query: { name },
    stage: 'commerce_publication_mapping_category_suggestions',
    ratePolicy: { key: 'sale-matching-categories', limit: 5, windowMs: 1000 },
  }, counter);
  return (Array.isArray(payload.matchingCategories) ? payload.matchingCategories : [])
    .slice(0, 20)
    .map(flattenMatchingCategory)
    .filter((item) => item.id);
}

function selectedValuesFromListing(listing) {
  const attrs = listing?.attributes && typeof listing.attributes === 'object' ? listing.attributes : {};
  return {
    product: mapParameterValues(attrs.productParameters),
    offer: mapParameterValues(attrs.offerParameters),
  };
}

function autoValueFor(parameter, commerceProduct) {
  const id = text(parameter?.id, 100);
  const name = text(parameter?.name, 500).toLowerCase();
  if ((KNOWN_GTIN_PARAMETER_IDS.has(id) || /^(ean|gtin|isbn|issn)$/.test(name)) && isLikelyGtin(commerceProduct?.ean)) {
    return { values: [text(commerceProduct.ean, 120).replace(/\s+/g, '')] };
  }
  if (text(parameter?.type, 80).toLowerCase() === 'string' && /^(marka|brand)$/.test(name) && text(commerceProduct?.brand, 300)) {
    return { values: [text(commerceProduct.brand, 300)] };
  }
  return {};
}

function conditionMatches(raw, valueById) {
  if (!raw || typeof raw !== 'object') return false;
  const withValue = Array.isArray(raw.parametersWithValue) ? raw.parametersWithValue : [];
  const withoutValue = Array.isArray(raw.parametersWithoutValue) ? raw.parametersWithoutValue : [];
  if (!withValue.length && !withoutValue.length) return false;

  const withOk = withValue.every((condition) => {
    const current = normalizeParameterValue(valueById.get(text(condition?.id, 100)) || {});
    if (!hasParameterValue(current)) return false;
    const allowed = new Set((Array.isArray(condition?.oneOfValueIds) ? condition.oneOfValueIds : []).map((value) => text(value, 200)).filter(Boolean));
    if (!allowed.size) return true;
    return current.valuesIds.some((value) => allowed.has(value));
  });
  const withoutOk = withoutValue.every((condition) => {
    const current = normalizeParameterValue(valueById.get(text(condition?.id, 100)) || {});
    return !hasParameterValue(current);
  });
  return withOk && withoutOk;
}

function baseRequiredForCurrentPath(parameter, hasCatalogProduct) {
  const describesProduct = parameter?.options?.describesProduct === true;
  if (describesProduct) {
    if (hasCatalogProduct) return parameter?.required === true;
    return parameter?.requiredForProduct === true || parameter?.required === true;
  }
  return parameter?.required === true;
}

function buildParameterState(parameters, { listing, selectedProduct, commerceProduct }) {
  const saved = selectedValuesFromListing(listing);
  const catalogValues = mapParameterValues(selectedProduct?.parameters || []);
  const currentById = new Map();

  for (const parameter of parameters) {
    const id = text(parameter?.id, 100);
    if (!id) continue;
    const describesProduct = parameter?.options?.describesProduct === true;
    const savedValue = (describesProduct ? saved.product : saved.offer).get(id);
    const catalogValue = describesProduct ? catalogValues.get(id) : null;
    const current = hasParameterValue(savedValue)
      ? savedValue
      : (hasParameterValue(catalogValue) ? catalogValue : autoValueFor(parameter, commerceProduct));
    currentById.set(id, current);
  }

  const all = [];
  const missing = [];
  const conditional = [];
  for (const parameter of parameters) {
    const id = text(parameter?.id, 100);
    if (!id) continue;
    const describesProduct = parameter?.options?.describesProduct === true;
    const current = currentById.get(id) || {};
    const conditionalActive = conditionMatches(parameter?.requiredIf, currentById);
    const required = baseRequiredForCurrentPath(parameter, Boolean(selectedProduct)) || conditionalActive;
    const item = sanitizeParameter(parameter, current);
    item.conditionalActive = conditionalActive;
    item.requiredNow = required;
    item.missing = required && !hasParameterValue(current);
    if (item.missing) missing.push({ id: item.id, name: item.name, scope: describesProduct ? 'product' : 'offer' });
    if (item.requiredIf) conditional.push({ id: item.id, name: item.name, scope: describesProduct ? 'product' : 'offer', active: conditionalActive });
    all.push(item);
  }

  return {
    all,
    product: all.filter((item) => item.describesProduct),
    offer: all.filter((item) => !item.describesProduct),
    missing,
    conditional,
  };
}

function listingMapping(listing) {
  const allegro = listing?.providerData?.allegro && typeof listing.providerData.allegro === 'object'
    ? listing.providerData.allegro
    : {};
  return {
    listingId: listing?._id ? String(listing._id) : '',
    state: text(allegro.mappingState, 40) || 'never',
    catalogProductId: text(allegro.catalogProductId, 160),
    categoryId: text(listing?.category?.id || allegro.categoryId, 100),
    lastResolvedAt: allegro.lastResolvedAt || null,
    mappedAt: allegro.mappedAt || null,
  };
}

async function resolveAllegroMapping(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  const [{ account, matrix }, commerceProduct, listing] = await Promise.all([
    requireAllegroMappingAccount(accountId),
    getCatalogProduct(productId),
    getListing(productId, accountId),
  ]);

  const counter = { count: 0 };
  const gtin = text(commerceProduct.ean, 120).replace(/\s+/g, '');
  let candidates = [];
  if (isLikelyGtin(gtin)) candidates = await findProductsByGtin(accountId, gtin, counter);

  const saved = listingMapping(listing);
  const requestedProductId = text(raw.catalogProductId, 160);
  const clearCatalogProduct = raw.clearCatalogProduct === true;
  let selectedProductId = clearCatalogProduct ? '' : (requestedProductId || saved.catalogProductId);
  if (!selectedProductId && candidates.length === 1) selectedProductId = candidates[0].id;
  let selectedProduct = null;
  if (selectedProductId) {
    selectedProduct = await getProductDetail(accountId, selectedProductId, counter);
    if (!selectedProduct) selectedProduct = candidates.find((item) => item.id === selectedProductId) || null;
  }

  const categoryPhrase = text(raw.categoryPhrase, 1024) || commerceProduct.name;
  let suggestions = [];
  const explicitCategoryId = text(raw.categoryId, 100);
  const clearCategory = raw.clearCategory === true;
  let categoryId = clearCategory ? '' : (explicitCategoryId || text(selectedProduct?.category?.id, 100) || saved.categoryId);

  if (!categoryId || raw.refreshSuggestions === true) {
    suggestions = await matchingCategories(accountId, categoryPhrase, counter);
  }

  const productCategoryCandidates = [];
  if (selectedProduct?.category?.id) {
    productCategoryCandidates.push({
      id: selectedProduct.category.id,
      name: selectedProduct.category.path?.at(-1) || '',
      path: selectedProduct.category.path || [],
      source: 'product',
    });
    for (const item of selectedProduct.category.similar || []) {
      productCategoryCandidates.push({
        id: item.id,
        name: item.path?.at(-1) || '',
        path: item.path || [],
        source: 'similar',
      });
    }
  }

  let category = null;
  let parameterState = { all: [], product: [], offer: [], missing: [], conditional: [] };
  if (categoryId) {
    category = await getCategoryDetail(accountId, categoryId, counter);
    if (category?.leaf !== true) {
      parameterState.missing.push({ id: 'category', name: 'Категорія має бути кінцевою (leaf)', scope: 'category' });
    }
    if (category?.options?.offersWithProductPublicationEnabled === false) {
      parameterState.missing.push({ id: 'category', name: 'У цій категорії Allegro не дозволяє product-offer publication', scope: 'category' });
    }
    const parameters = await getCategoryParameters(accountId, categoryId, counter);
    const built = buildParameterState(parameters, { listing, selectedProduct, commerceProduct });
    parameterState = {
      ...built,
      missing: [...parameterState.missing, ...built.missing],
    };
  }

  const ambiguousCatalogMatch = candidates.length > 1 && !selectedProduct;
  const catalogMissing = isLikelyGtin(gtin) && candidates.length === 0;
  const categoryMissing = !categoryId;
  const ready = Boolean(category && category.leaf && category.options.offersWithProductPublicationEnabled !== false)
    && !ambiguousCatalogMatch
    && parameterState.missing.length === 0;

  return {
    stage: '3B',
    provider: 'allegro',
    providerWriteCalls: 0,
    providerReadCalls: counter.count,
    product: {
      id: commerceProduct.id,
      name: commerceProduct.name,
      sku: commerceProduct.sku,
      ean: commerceProduct.ean,
      brand: commerceProduct.brand,
      imageUrl: commerceProduct.media?.[0]?.url || '',
    },
    account: {
      accountId,
      name: account.name || account.login || accountId,
      login: account.login || '',
      saleOffersRead: matrix.capabilities.saleOffersRead === true,
      saleOffersWrite: matrix.capabilities.saleOffersWrite === true,
    },
    gtin: {
      value: gtin,
      valid: isLikelyGtin(gtin),
      searched: isLikelyGtin(gtin),
      matchCount: candidates.length,
      ambiguous: ambiguousCatalogMatch,
      noMatch: catalogMissing,
    },
    catalogProducts: candidates,
    selectedCatalogProduct: selectedProduct,
    categoryCandidates: productCategoryCandidates,
    suggestedCategories: suggestions,
    selectedCategory: category,
    parameters: parameterState,
    existingMapping: saved,
    mapping: {
      ready,
      strategy: selectedProduct ? 'catalog_product' : 'new_product',
      catalogProductId: selectedProduct?.id || '',
      categoryId: category?.id || '',
      needsCatalogProductChoice: ambiguousCatalogMatch,
      needsCategoryChoice: categoryMissing,
      missingParameterCount: parameterState.missing.length,
      conditionalParameterCount: parameterState.conditional.length,
    },
  };
}

function normalizeParameterArray(raw) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, 1000)) {
    const id = text(item?.id, 100);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const value = normalizeParameterValue(item);
    if (!hasParameterValue(value)) continue;
    out.push({ id, ...value });
  }
  return out;
}

async function saveAllegroMapping(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  // Resolve against fresh Allegro category/parameter metadata before persisting.
  const resolved = await resolveAllegroMapping({
    productId,
    accountId,
    catalogProductId: raw.catalogProductId,
    clearCatalogProduct: !text(raw.catalogProductId, 160),
    categoryId: raw.categoryId,
  });
  if (!resolved.mapping.categoryId) throw appError('commerce_allegro_category_required');

  const allowedIds = new Set(resolved.parameters.all.map((item) => item.id));
  const productParameters = normalizeParameterArray(raw.productParameters).filter((item) => allowedIds.has(item.id));
  const offerParameters = normalizeParameterArray(raw.offerParameters).filter((item) => allowedIds.has(item.id));

  let listing = await ChannelListing.findOne({ commerceProductId: productId, provider: 'allegro', accountId });
  if (!listing) listing = new ChannelListing({ commerceProductId: productId, provider: 'allegro', accountId });

  listing.category = {
    id: resolved.selectedCategory.id,
    name: resolved.selectedCategory.name || '',
    path: [],
  };
  listing.attributes = {
    ...(listing.attributes && typeof listing.attributes === 'object' ? listing.attributes : {}),
    productParameters,
    offerParameters,
  };
  const previousProviderData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  listing.providerData = {
    ...previousProviderData,
    allegro: {
      ...(previousProviderData.allegro && typeof previousProviderData.allegro === 'object' ? previousProviderData.allegro : {}),
      catalogProductId: resolved.mapping.catalogProductId || '',
      categoryId: resolved.mapping.categoryId,
      mappingStrategy: resolved.mapping.strategy,
      mappingState: 'incomplete',
      lastResolvedAt: new Date(),
      mappedAt: new Date(),
      gtin: resolved.gtin.value || '',
    },
  };
  await listing.save();

  // Re-resolve once from persisted values; Stage 3C will only accept ready mappings.
  const verified = await resolveAllegroMapping({
    productId,
    accountId,
    catalogProductId: resolved.mapping.catalogProductId,
    categoryId: resolved.mapping.categoryId,
  });
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  providerData.allegro = {
    ...(providerData.allegro || {}),
    mappingState: verified.mapping.ready ? 'ready' : 'incomplete',
    missingParameterIds: verified.parameters.missing.map((item) => item.id).slice(0, 200),
    lastResolvedAt: new Date(),
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();

  return {
    saved: true,
    listingId: String(listing._id),
    mappingState: verified.mapping.ready ? 'ready' : 'incomplete',
    ...verified,
  };
}

module.exports = {
  resolveAllegroMapping,
  saveAllegroMapping,
};
