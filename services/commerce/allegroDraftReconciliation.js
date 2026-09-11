'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getCatalogProduct } = require('./catalog');
const { buildDraftPayload, stableExternalKey, requestHash } = require('./allegroDraftOffer');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const CREATE_ACTION = 'create_draft';

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function moneyCents(value) {
  return Math.round(number(value, 0) * 100);
}

function publicationToListingStatus(status) {
  switch (text(status, 40).toUpperCase()) {
    case 'ACTIVE': return 'active';
    case 'ACTIVATING': return 'publishing';
    case 'ENDED': return 'ended';
    default: return 'draft';
  }
}

function issue(code, message, { blocking = false, field = '', expected = null, actual = null } = {}) {
  return {
    code,
    severity: blocking ? 'error' : 'warning',
    blocking: blocking === true,
    message: text(message, 1200),
    field: text(field, 120),
    expected,
    actual,
  };
}

function firstProductId(payload) {
  const set = Array.isArray(payload?.productSet) ? payload.productSet : [];
  return text(set[0]?.product?.id, 200);
}

function publicOfferSnapshot(offer = {}) {
  return {
    id: text(offer.id, 200),
    externalId: text(offer?.external?.id, 100),
    name: text(offer.name, 300),
    categoryId: text(offer?.category?.id, 100),
    publicationStatus: text(offer?.publication?.status, 40).toUpperCase(),
    price: {
      amount: text(offer?.sellingMode?.price?.amount, 40),
      currency: text(offer?.sellingMode?.price?.currency, 10).toUpperCase(),
    },
    stock: {
      available: Math.max(0, Math.floor(number(offer?.stock?.available, 0))),
    },
    catalogProductId: firstProductId(offer),
    imageCount: Array.isArray(offer.images) ? offer.images.length : 0,
    productSetCount: Array.isArray(offer.productSet) ? offer.productSet.length : 0,
  };
}

function expectedSnapshot(payload = {}) {
  return {
    externalId: text(payload?.external?.id, 100),
    name: text(payload?.name, 300),
    categoryId: text(payload?.category?.id, 100),
    publicationStatus: 'INACTIVE',
    price: {
      amount: text(payload?.sellingMode?.price?.amount, 40),
      currency: text(payload?.sellingMode?.price?.currency, 10).toUpperCase(),
    },
    stock: {
      available: Math.max(0, Math.floor(number(payload?.stock?.available, 0))),
    },
    catalogProductId: firstProductId(payload),
  };
}

function compareOffer({ expected, actual, createRequestHash, currentDesiredHash }) {
  const issues = [];
  if (actual.externalId !== expected.externalId) {
    issues.push(issue('external_id_mismatch', 'Allegro offer має інший external.id, ніж наш ChannelListing.', {
      blocking: true, field: 'external.id', expected: expected.externalId, actual: actual.externalId,
    }));
  }
  if (actual.publicationStatus !== 'INACTIVE') {
    issues.push(issue('publication_status_not_inactive', `Offer у Allegro має статус ${actual.publicationStatus || 'UNKNOWN'}, хоча Stage 3D.1 очікує INACTIVE draft.`, {
      blocking: true, field: 'publication.status', expected: 'INACTIVE', actual: actual.publicationStatus || 'UNKNOWN',
    }));
  }
  if (actual.name !== expected.name) {
    issues.push(issue('name_drift', 'Назва offer в Allegro відрізняється від поточного Commerce Catalog.', {
      blocking: true, field: 'name', expected: expected.name, actual: actual.name,
    }));
  }
  if (actual.categoryId !== expected.categoryId) {
    issues.push(issue('category_drift', 'Категорія offer в Allegro відрізняється від збереженого mapping.', {
      blocking: true, field: 'category.id', expected: expected.categoryId, actual: actual.categoryId,
    }));
  }
  if (actual.price.currency !== expected.price.currency || moneyCents(actual.price.amount) !== moneyCents(expected.price.amount)) {
    issues.push(issue('price_drift', 'Ціна offer в Allegro відрізняється від поточної ціни Commerce Catalog/ChannelListing.', {
      blocking: true, field: 'sellingMode.price', expected: expected.price, actual: actual.price,
    }));
  }
  if (actual.stock.available !== expected.stock.available) {
    issues.push(issue('stock_drift', 'Залишок offer в Allegro відрізняється від поточного розрахованого stock.', {
      blocking: true, field: 'stock.available', expected: expected.stock.available, actual: actual.stock.available,
    }));
  }
  if (expected.catalogProductId && actual.catalogProductId !== expected.catalogProductId) {
    issues.push(issue('catalog_product_drift', 'Offer прив’язаний до іншого продукту Каталогу Allegro.', {
      blocking: true, field: 'productSet[0].product.id', expected: expected.catalogProductId, actual: actual.catalogProductId,
    }));
  }
  const localChangedSinceCreate = Boolean(createRequestHash && currentDesiredHash && createRequestHash !== currentDesiredHash);
  if (localChangedSinceCreate) {
    issues.push(issue('local_payload_changed_since_create', 'Commerce Product або ChannelListing змінився після створення draft. Перед активацією треба синхронізувати зміни в Allegro.', {
      blocking: true, field: 'desiredHash', expected: currentDesiredHash, actual: createRequestHash,
    }));
  }
  return { issues, localChangedSinceCreate };
}

async function requireReadAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true) {
    throw appError('commerce_allegro_reconcile_scope_required');
  }
  return account;
}

async function getListing(productId, accountId) {
  const listing = await ChannelListing.findOne({ commerceProductId: productId, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  if (!text(listing.externalId, 200)) throw appError('commerce_allegro_draft_not_bound');
  return listing;
}

async function persistReconciliation({ listing, reconciliation, currentDesiredHash, appliedHash }) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  providerData.allegro = {
    ...(providerData.allegro || {}),
    reconciliation,
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  listing.status = publicationToListingStatus(reconciliation.offer?.publicationStatus);
  listing.syncState = {
    ...(listing.syncState?.toObject?.() || listing.syncState || {}),
    state: reconciliation.readyForNextStage ? 'in_sync' : 'out_of_sync',
    desiredHash: currentDesiredHash || listing.syncState?.desiredHash || '',
    appliedHash: reconciliation.readyForNextStage ? currentDesiredHash : (appliedHash || listing.syncState?.appliedHash || ''),
    lastSyncAt: new Date(reconciliation.checkedAt),
    lastError: reconciliation.readyForNextStage ? '' : reconciliation.issues.map((row) => row.message).slice(0, 4).join(' · '),
  };
  await listing.save();
}

async function reconcileAllegroDraft(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireReadAccount(accountId);
  const [product, listing] = await Promise.all([
    getCatalogProduct(productId),
    getListing(productId, accountId),
  ]);
  const externalKey = stableExternalKey(listing._id);
  const payload = buildDraftPayload({ product, listing, externalKey });
  const currentDesiredHash = requestHash(payload);
  const createJob = await CommercePublicationJob.findOne({
    channelListingId: listing._id,
    provider: PROVIDER,
    action: CREATE_ACTION,
  }).sort({ updatedAt: -1 }).lean();

  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_publication_draft_reconcile',
  });
  const offer = result.payload || {};
  if (!text(offer.id, 200)) throw appError('commerce_allegro_reconcile_response_invalid');

  const expected = expectedSnapshot(payload);
  const actual = publicOfferSnapshot(offer);
  const compared = compareOffer({
    expected,
    actual,
    createRequestHash: text(createJob?.requestHash, 128),
    currentDesiredHash,
  });
  const blockingCount = compared.issues.filter((row) => row.blocking).length;
  const warningCount = compared.issues.length - blockingCount;
  const checkedAt = new Date().toISOString();
  const reconciliation = {
    stage: '3D.1',
    state: blockingCount ? 'drift' : 'in_sync',
    checkedAt,
    readyForNextStage: blockingCount === 0,
    blockingCount,
    warningCount,
    localChangedSinceCreate: compared.localChangedSinceCreate,
    createRequestHash: text(createJob?.requestHash, 128),
    currentDesiredHash,
    expected,
    offer: actual,
    issues: compared.issues,
    traceId: text(result.traceId, 256),
    requestId: text(result.requestId, 128),
  };

  await persistReconciliation({
    listing,
    reconciliation,
    currentDesiredHash,
    appliedHash: text(createJob?.requestHash, 128),
  });

  return {
    stage: '3D.1',
    readOnlyUpstream: true,
    providerCalls: 1,
    productId,
    accountId,
    listingId: String(listing._id),
    offerId: actual.id,
    ...reconciliation,
  };
}

module.exports = {
  compareOffer,
  publicOfferSnapshot,
  reconcileAllegroDraft,
};
