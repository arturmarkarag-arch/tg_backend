'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getCatalogProduct } = require('./catalog');
const { previewPublication, effectivePrice, effectiveStock } = require('./publicationPreview');
const { resolveAllegroMapping } = require('./allegroMapping');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const ACTION = 'create_draft';
const PROVIDER = 'allegro';
const SENDING_STALE_MS = 45_000;

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function stableExternalKey(listingId) {
  return `ZLW-${text(listingId, 80)}`.slice(0, 100);
}

function idempotencyKey(listing) {
  return `allegro:${ACTION}:${text(listing.identityKey || `${listing.commerceProductId}:${listing.accountId}`, 300)}`;
}

function normalizedParameter(row = {}) {
  const out = { id: text(row.id, 100) };
  const valuesIds = (Array.isArray(row.valuesIds) ? row.valuesIds : []).map((value) => text(value, 300)).filter(Boolean).slice(0, 100);
  const values = (Array.isArray(row.values) ? row.values : []).map((value) => text(value, 1000)).filter(Boolean).slice(0, 100);
  const from = text(row?.rangeValue?.from, 300);
  const to = text(row?.rangeValue?.to, 300);
  if (valuesIds.length) out.valuesIds = valuesIds;
  if (values.length) out.values = values;
  if (from || to) out.rangeValue = { from: from || null, to: to || null };
  return out.id && (out.valuesIds || out.values || out.rangeValue) ? out : null;
}

function parameterArray(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizedParameter).filter(Boolean).slice(0, 1000);
}

function imageUrls(product) {
  const urls = [];
  for (const item of (Array.isArray(product?.media) ? product.media : [])) {
    const url = text(item?.url, 2500);
    if (!/^https?:\/\//i.test(url) || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= 16) break;
  }
  return urls;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function descriptionObject(value) {
  const raw = text(value, 30_000);
  if (!raw) return null;
  const paragraphs = raw.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean).slice(0, 120);
  const content = paragraphs.length
    ? paragraphs.map((part) => `<p>${escapeHtml(part)}</p>`).join('')
    : `<p>${escapeHtml(raw)}</p>`;
  return { sections: [{ items: [{ type: 'TEXT', content }] }] };
}

function amount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function mappingData(listing) {
  const providerData = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  return providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
}

function buildDraftPayload({ product, listing, externalKey }) {
  const allegro = mappingData(listing);
  const categoryId = text(listing?.category?.id || allegro.categoryId, 100);
  const catalogProductId = text(allegro.catalogProductId, 160);
  const strategy = text(allegro.mappingStrategy, 40) || (catalogProductId ? 'catalog_product' : 'new_product');
  const attrs = listing?.attributes && typeof listing.attributes === 'object' ? listing.attributes : {};
  const productParameters = parameterArray(attrs.productParameters);
  const offerParameters = parameterArray(attrs.offerParameters);
  const images = imageUrls(product);
  const title = text(listing?.titleOverride || product?.name, 75);
  const price = effectivePrice(product, listing);
  const stock = effectiveStock(product, listing);
  const description = descriptionObject(listing?.descriptionOverride || product?.description);

  if (!categoryId || allegro.mappingState !== 'ready') throw appError('commerce_allegro_mapping_not_ready');
  if (strategy === 'new_product' && !images.length) throw appError('commerce_allegro_draft_images_required');

  const productNode = catalogProductId
    ? { id: catalogProductId }
    : {
      name: title,
      category: { id: categoryId },
      parameters: productParameters,
      ...(images.length ? { images } : {}),
    };

  // Persisted product parameters are deliberately sent for both mapping paths.
  // For a catalog product Stage 3B pre-fills them from Allegro and the operator
  // only edits parameters exposed by the current category. Allegro remains the
  // final validator and returns 422 instead of us silently guessing values.
  if (catalogProductId && productParameters.length) productNode.parameters = productParameters;

  return {
    productSet: [{ product: productNode }],
    name: title,
    category: { id: categoryId },
    ...(offerParameters.length ? { parameters: offerParameters } : {}),
    sellingMode: {
      format: 'BUY_NOW',
      price: { amount: amount(price.value), currency: price.currency || 'PLN' },
    },
    stock: { available: Math.max(0, Math.floor(Number(stock.available || 0))) },
    publication: { status: 'INACTIVE' },
    external: { id: externalKey },
    ...(images.length ? { images } : {}),
    ...(description ? { description } : {}),
  };
}

function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function offerIdFromLocation(location) {
  const value = text(location, 2048);
  const match = value.match(/\/sale\/product-offers\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function operationIdFromLocation(location) {
  const value = text(location, 2048);
  const match = value.match(/\/operations\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function apiPathFromLocation(location) {
  const value = text(location, 2048);
  if (!value) return '';
  try {
    const parsed = new URL(value, 'https://api.allegro.pl');
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return value.startsWith('/') ? value : '';
  }
}

function statusFromPublication(status) {
  switch (text(status, 40).toUpperCase()) {
    case 'ACTIVE': return 'active';
    case 'ACTIVATING': return 'publishing';
    case 'ENDED': return 'ended';
    default: return 'draft';
  }
}

async function persistListingDraftState(listing, patch = {}) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const current = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...current,
    draftCreation: {
      ...(current.draftCreation && typeof current.draftCreation === 'object' ? current.draftCreation : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

function publicJob(job, listing, extra = {}) {
  const row = typeof job?.toObject === 'function' ? job.toObject() : (job || {});
  return {
    stage: '3C',
    provider: PROVIDER,
    action: ACTION,
    jobId: text(row.jobId, 80),
    state: text(row.state, 40) || 'reserved',
    productId: String(row.commerceProductId || listing?.commerceProductId || ''),
    accountId: text(row.accountId || listing?.accountId, 80),
    listingId: String(row.channelListingId || listing?._id || ''),
    offerId: text(row.providerEntityId || listing?.externalId, 160),
    externalKey: text(row.externalKey, 100),
    operationPath: text(row.providerOperationPath, 2048),
    attempts: Number(row.attempts || 0),
    lastErrorCode: text(row.lastErrorCode, 160),
    lastError: text(row.lastError, 1500),
    lastHttpStatus: Number(row.lastHttpStatus || 0),
    ...extra,
  };
}

async function requireWriteAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersWrite !== true) {
    throw appError('commerce_allegro_draft_scope_required');
  }
  return account;
}

async function getListing(productId, accountId) {
  const listing = await ChannelListing.findOne({ commerceProductId: productId, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  return listing;
}

async function findOfferByExternalKey(accountId, externalKey) {
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: '/sale/offers',
    query: { 'external.id': externalKey, limit: 3 },
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_publication_draft_recovery',
  });
  const matches = (Array.isArray(result.payload?.offers) ? result.payload.offers : [])
    .filter((offer) => text(offer?.external?.id, 100) === externalKey);
  if (matches.length > 1) throw appError('commerce_allegro_draft_recovery_ambiguous');
  return matches[0] || null;
}

async function ensureJob(listing, externalKey) {
  const key = idempotencyKey(listing);
  let job = await CommercePublicationJob.findOne({ idempotencyKey: key });
  if (job) return job;
  try {
    job = await CommercePublicationJob.create({
      idempotencyKey: key,
      provider: PROVIDER,
      action: ACTION,
      commerceProductId: listing.commerceProductId,
      channelListingId: listing._id,
      accountId: listing.accountId,
      externalKey,
      state: 'reserved',
    });
    return job;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey: key });
  }
}

async function bindConfirmedOffer({ listing, job, offer, hash = '', recovered = false }) {
  const offerId = text(offer?.id || job?.providerEntityId || listing.externalId, 160);
  if (!offerId) throw appError('commerce_allegro_draft_response_invalid');
  const publicationStatus = text(offer?.publication?.status, 40).toUpperCase() || 'INACTIVE';
  const now = new Date();
  listing.externalId = offerId;
  listing.status = statusFromPublication(publicationStatus);
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  providerData.allegro = {
    ...(providerData.allegro || {}),
    draftCreation: {
      state: 'confirmed',
      externalKey: job.externalKey,
      offerId,
      publicationStatus,
      operationPath: text(job.providerOperationPath, 2048),
      recovered: recovered === true,
      confirmedAt: now,
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  listing.syncState = {
    ...(listing.syncState?.toObject?.() || listing.syncState || {}),
    state: 'in_sync',
    desiredHash: hash || job.requestHash || listing.syncState?.desiredHash || '',
    appliedHash: hash || job.requestHash || listing.syncState?.appliedHash || '',
    lastSyncAt: now,
    lastError: '',
  };
  await listing.save();

  job.state = 'confirmed';
  job.providerEntityId = offerId;
  job.providerStatus = publicationStatus;
  job.completedAt = now;
  job.lastError = '';
  job.lastErrorCode = '';
  job.lastHttpStatus = 0;
  job.resultSnapshot = {
    id: offerId,
    publicationStatus,
    recovered: recovered === true,
  };
  await job.save();
  return publicJob(job, listing, { recovered: recovered === true, publicationStatus });
}

async function recoverExisting({ listing, job, hash = '' }) {
  const offer = await findOfferByExternalKey(listing.accountId, job.externalKey);
  if (!offer) return null;
  return bindConfirmedOffer({ listing, job, offer, hash, recovered: true });
}

function errorIsAmbiguous(error) {
  const code = text(error?.code, 160);
  if (['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code)) return true;
  const upstreamStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
  return upstreamStatus === 408 || upstreamStatus === 425 || upstreamStatus >= 500;
}

async function markFailure(job, error, state) {
  job.state = state;
  job.lockToken = '';
  job.lastErrorCode = text(error?.code || error?.args?.upstreamCode, 160);
  job.lastError = text(error?.message, 1500);
  job.lastHttpStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || error?.status || 0);
  await job.save();
}

async function refreshPendingOperation({ listing, job, hash = '' }) {
  if (!job.providerOperationPath) return null;
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: job.providerOperationPath,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_publication_draft_operation',
  });
  job.providerTraceId = result.traceId || job.providerTraceId;
  job.providerRequestId = result.requestId || job.providerRequestId;
  if (result.status === 202 || result.pending === true || result.payload?.operation?.status === 'IN_PROGRESS') {
    job.state = 'pending';
    job.providerEntityId = text(result.payload?.offer?.id || job.providerEntityId, 160);
    job.providerOperationId = text(result.payload?.operation?.id || job.providerOperationId, 160);
    await job.save();
    return publicJob(job, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
  }
  // Node fetch follows Allegro's 303 to GET /sale/product-offers/{offerId}; a
  // completed operation therefore arrives here as the final offer payload (200).
  if (result.payload?.id || job.providerEntityId) {
    return bindConfirmedOffer({ listing, job, offer: result.payload || { id: job.providerEntityId }, hash });
  }
  return null;
}

async function preflightForCreate(productId, accountId) {
  const preview = await previewPublication({
    productIds: [productId],
    targets: [{ provider: PROVIDER, accountId }],
  });
  const row = preview.rows?.[0];
  if (!row) throw appError('commerce_allegro_draft_preflight_failed');
  if (row.mode !== 'create') return { row, alreadyBound: true };
  if (!row.ready) {
    throw appError('commerce_allegro_draft_preflight_failed', {
      issues: (row.issues || []).filter((item) => item.level === 'error').map((item) => item.message).slice(0, 20),
    });
  }
  return { row, alreadyBound: false };
}

async function createAllegroDraft(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireWriteAccount(accountId);
  const preflight = await preflightForCreate(productId, accountId);
  const [product, listing] = await Promise.all([
    getCatalogProduct(productId),
    getListing(productId, accountId),
  ]);
  const externalKey = stableExternalKey(listing._id);
  const job = await ensureJob(listing, externalKey);

  if (job.state === 'confirmed') {
    return publicJob(job, listing, { alreadyBound: true, publicationStatus: mappingData(listing)?.draftCreation?.publicationStatus || '' });
  }
  if (job.state === 'pending') {
    const refreshed = await refreshPendingOperation({ listing, job, hash: job.requestHash });
    if (refreshed) return refreshed;
  }
  if (job.state === 'unknown') {
    const recoveredUnknown = await recoverExisting({ listing, job, hash: job.requestHash });
    if (recoveredUnknown) return recoveredUnknown;
    return publicJob(job, listing, {
      ambiguous: true,
      message: 'Попередній POST має невідомий результат. Автоматичний повтор заблоковано, щоб не створити дубль. Натисніть «Перевірити Allegro».',
    });
  }
  if (listing.externalId || preflight.alreadyBound) {
    return publicJob(job, listing, { alreadyBound: true, offerId: listing.externalId });
  }

  // Re-read Allegro category/parameter metadata immediately before the write.
  // A mapping that was ready yesterday may no longer satisfy today's category.
  const freshMapping = await resolveAllegroMapping({
    productId,
    accountId,
    catalogProductId: mappingData(listing).catalogProductId || '',
    categoryId: listing.category?.id || '',
  });
  if (!freshMapping.mapping?.ready) {
    throw appError('commerce_allegro_mapping_not_ready', {
      missing: (freshMapping.parameters?.missing || []).map((item) => item.name).slice(0, 20),
    });
  }

  const payload = buildDraftPayload({ product, listing, externalKey });
  const hash = requestHash(payload);
  job.requestHash = hash;
  job.externalKey = externalKey;

  // Recovery is always attempted before POST. This covers a previous process
  // crash after Allegro accepted the request but before Mongo persisted offerId.
  const recovered = await recoverExisting({ listing, job, hash });
  if (recovered) return recovered;

  if (job.state === 'sending' && Date.now() - new Date(job.lastAttemptAt || job.updatedAt || 0).getTime() < SENDING_STALE_MS) {
    return publicJob(job, listing, { inProgress: true });
  }
  if (job.state === 'sending') {
    job.state = 'unknown';
    job.lockToken = '';
    job.lastErrorCode = 'local_create_outcome_unknown';
    job.lastError = 'Процес перервався під час POST /sale/product-offers; повтор заблоковано до recovery.';
    await job.save();
    await persistListingDraftState(listing, { state: 'unknown', externalKey, lastErrorCode: job.lastErrorCode, lastError: job.lastError });
    return publicJob(job, listing, { ambiguous: true });
  }

  const lockToken = crypto.randomUUID();
  const claimed = await CommercePublicationJob.findOneAndUpdate({
    _id: job._id,
    state: { $in: ['reserved', 'failed'] },
  }, {
    $set: {
      state: 'sending',
      lockToken,
      requestHash: hash,
      externalKey,
      lastAttemptAt: new Date(),
      lastError: '',
      lastErrorCode: '',
      lastHttpStatus: 0,
    },
    $inc: { attempts: 1 },
  }, { new: true });
  if (!claimed || claimed.lockToken !== lockToken) {
    const current = await CommercePublicationJob.findById(job._id);
    return publicJob(current || job, listing, { inProgress: true });
  }

  await persistListingDraftState(listing, {
    state: 'sending',
    externalKey,
    startedAt: claimed.lastAttemptAt || new Date(),
  });

  try {
    // POST is intentionally never retried by allegroRequest. A transport failure
    // has an ambiguous outcome; retrying automatically could create a duplicate.
    const result = await allegroRequest(accountId, {
      method: 'POST',
      path: '/sale/product-offers',
      body: payload,
      retryPolicy: 'never',
      maxAttempts: 1,
      stage: 'commerce_publication_create_draft',
    });

    claimed.lockToken = '';
    claimed.providerTraceId = result.traceId || '';
    claimed.providerRequestId = result.requestId || '';
    claimed.lastHttpStatus = result.status || 0;
    const operationPath = apiPathFromLocation(result.location);
    const offerId = text(result.payload?.id || result.payload?.offer?.id || offerIdFromLocation(result.location), 160);
    const operationId = text(result.payload?.operation?.id || operationIdFromLocation(result.location), 160);
    claimed.providerEntityId = offerId;
    claimed.providerOperationPath = operationPath;
    claimed.providerOperationId = operationId;

    if (result.status === 202 || result.pending === true) {
      claimed.state = 'pending';
      claimed.providerStatus = 'PROCESSING';
      await claimed.save();
      if (offerId) {
        listing.externalId = offerId;
        listing.status = 'queued';
        const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
        providerData.allegro = {
          ...(providerData.allegro || {}),
          draftCreation: {
            state: 'pending', externalKey, offerId, operationPath, operationId, startedAt: new Date(),
          },
        };
        listing.providerData = providerData;
        listing.markModified('providerData');
        await listing.save();
      }
      return publicJob(claimed, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
    }

    return bindConfirmedOffer({ listing, job: claimed, offer: result.payload || { id: offerId }, hash });
  } catch (error) {
    claimed.lockToken = '';
    if (errorIsAmbiguous(error)) {
      // One immediate lookup can recover a request that Allegro accepted before
      // our connection died. If it is not visible yet, remain UNKNOWN and never
      // issue a second POST automatically.
      try {
        const found = await recoverExisting({ listing, job: claimed, hash });
        if (found) return found;
      } catch (_) { /* preserve the original ambiguous outcome */ }
      await markFailure(claimed, error, 'unknown');
      await persistListingDraftState(listing, {
        state: 'unknown',
        externalKey,
        lastErrorCode: claimed.lastErrorCode,
        lastError: claimed.lastError,
      });
      return publicJob(claimed, listing, {
        ambiguous: true,
        message: 'Allegro не підтвердив результат створення. Повторний POST заблокований до recovery, щоб уникнути дубля.',
      });
    }
    await markFailure(claimed, error, 'failed');
    await persistListingDraftState(listing, {
      state: 'failed',
      externalKey,
      lastErrorCode: claimed.lastErrorCode,
      lastError: claimed.lastError,
    });
    throw error;
  }
}

async function refreshAllegroDraft(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');
  await requireWriteAccount(accountId);
  const listing = await getListing(productId, accountId);
  const externalKey = stableExternalKey(listing._id);
  const job = await ensureJob(listing, externalKey);

  if (job.state === 'confirmed' && (listing.externalId || job.providerEntityId)) {
    return publicJob(job, listing, { alreadyBound: true });
  }
  if (job.state === 'pending' && job.providerOperationPath) {
    try {
      const refreshed = await refreshPendingOperation({ listing, job, hash: job.requestHash });
      if (refreshed) return refreshed;
    } catch (error) {
      if (!errorIsAmbiguous(error)) {
        await markFailure(job, error, 'failed');
        throw error;
      }
      // Fall through to external.id recovery for ambiguous operation polling.
    }
  }

  const recovered = await recoverExisting({ listing, job, hash: job.requestHash });
  if (recovered) return recovered;
  if (job.state === 'sending') {
    job.state = 'unknown';
    job.lockToken = '';
    job.lastErrorCode = 'local_create_outcome_unknown';
    job.lastError = 'Немає підтвердження завершення POST /sale/product-offers.';
    await job.save();
    await persistListingDraftState(listing, { state: 'unknown', externalKey, lastErrorCode: job.lastErrorCode, lastError: job.lastError });
  }
  return publicJob(job, listing, {
    ambiguous: job.state === 'unknown' || job.state === 'sending',
    message: job.state === 'unknown' || job.state === 'sending'
      ? 'Offer з нашим external.id поки не знайдений. Автоматичний повтор POST залишається заблокованим.'
      : 'Draft у Allegro ще не знайдений.',
  });
}

module.exports = {
  buildDraftPayload,
  createAllegroDraft,
  refreshAllegroDraft,
  stableExternalKey,
  requestHash,
};
