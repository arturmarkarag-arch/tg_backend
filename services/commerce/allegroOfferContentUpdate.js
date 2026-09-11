'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');
const { requestHash } = require('./allegroDraftOffer');
const {
  previewAllegroOfferUpdate,
  contentPatchIssues,
} = require('./allegroOfferUpdatePreview');

const PROVIDER = 'allegro';
const ACTION = 'update_offer_content';
const SENDING_STALE_MS = 45_000;

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
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

function operationIdFromLocation(location) {
  const match = text(location, 2048).match(/\/operations\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function savedAllegro(listing) {
  const providerData = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  return providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
}

function savedContentUpdate(listing) {
  const allegro = savedAllegro(listing);
  return allegro.contentUpdate && typeof allegro.contentUpdate === 'object' ? allegro.contentUpdate : {};
}

async function requireUpdateAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true || matrix.capabilities.saleOffersWrite !== true) {
    throw appError('commerce_allegro_content_update_scope_required');
  }
  return account;
}

async function requireListing(productId, accountId) {
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  const listing = await ChannelListing.findOne({ commerceProductId: productId, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  if (!text(listing.externalId, 200)) throw appError('commerce_allegro_draft_not_bound');
  return listing;
}

async function persistContentUpdate(listing, patch = {}) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...allegro,
    contentUpdate: {
      ...(allegro.contentUpdate && typeof allegro.contentUpdate === 'object' ? allegro.contentUpdate : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

function idempotencyKey(listing, patchHash) {
  return `allegro:${ACTION}:${text(listing._id, 80)}:${text(patchHash, 128)}`;
}

async function ensureJob(listing, patchHash, preview) {
  const key = idempotencyKey(listing, patchHash);
  let job = await CommercePublicationJob.findOne({ idempotencyKey: key });
  if (job) return job;
  try {
    return await CommercePublicationJob.create({
      idempotencyKey: key,
      provider: PROVIDER,
      action: ACTION,
      commerceProductId: listing.commerceProductId,
      channelListingId: listing._id,
      accountId: listing.accountId,
      externalKey: text(listing.externalId, 200),
      requestHash: patchHash,
      state: 'reserved',
      resultSnapshot: {
        previewDesiredHash: text(preview?.desiredHash, 128),
        contentPatch: preview?.contentPatch || {},
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey: key });
  }
}

async function unresolvedJob(listing) {
  return CommercePublicationJob.findOne({
    channelListingId: listing._id,
    provider: PROVIDER,
    action: ACTION,
    state: { $in: ['sending', 'pending', 'unknown'] },
  }).sort({ updatedAt: -1 });
}

function publicState(job, listing, extra = {}) {
  const row = typeof job?.toObject === 'function' ? job.toObject() : (job || {});
  const saved = savedContentUpdate(listing);
  return {
    stage: '3D.4.1',
    provider: PROVIDER,
    action: ACTION,
    productId: String(row.commerceProductId || listing?.commerceProductId || ''),
    accountId: text(row.accountId || listing?.accountId, 80),
    listingId: String(row.channelListingId || listing?._id || ''),
    offerId: text(row.providerEntityId || listing?.externalId, 200),
    jobId: text(row.jobId, 80),
    state: text(row.state, 40) || text(saved.state, 40) || 'reserved',
    requestHash: text(row.requestHash, 128),
    desiredHash: text(saved.desiredHash || row?.resultSnapshot?.previewDesiredHash, 128),
    appliedHash: text(saved.appliedHash, 128),
    operationPath: text(row.providerOperationPath, 2048),
    attempts: Number(row.attempts || 0),
    lastErrorCode: text(row.lastErrorCode, 160),
    lastError: text(row.lastError, 1500),
    canRetry: saved.canRetry === true,
    ...extra,
  };
}

function errorIsAmbiguous(error) {
  const code = text(error?.code, 160);
  if (['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code)) return true;
  const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
  return status === 408 || status === 425 || status >= 500;
}

async function readOffer(listing, stage) {
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage,
  });
  if (!text(result.payload?.id, 200)) throw appError('commerce_allegro_content_update_response_invalid');
  return { result, offer: result.payload };
}

function storedPatch(job) {
  const patch = job?.resultSnapshot?.contentPatch;
  return patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
}

async function markConfirmed(listing, job, { recovered = false } = {}) {
  const now = new Date();
  const currentPreview = await previewAllegroOfferUpdate({
    productId: String(listing.commerceProductId),
    accountId: listing.accountId,
  });
  const originalDesiredHash = text(job?.resultSnapshot?.previewDesiredHash, 128);
  const currentDesiredHash = text(currentPreview.desiredHash, 128);
  const stillCurrent = Boolean(originalDesiredHash) && originalDesiredHash === currentDesiredHash && currentPreview.contentChangeCount === 0;

  job.state = 'confirmed';
  job.lockToken = '';
  job.providerEntityId = text(listing.externalId, 200);
  job.providerStatus = 'ACTIVE';
  job.completedAt = now;
  job.lastError = '';
  job.lastErrorCode = '';
  job.resultSnapshot = {
    ...(job.resultSnapshot || {}),
    verifiedAt: now,
    recovered: recovered === true,
    stillCurrent,
    currentDesiredHash,
    deferredChangeCount: Number(currentPreview.deferredChangeCount || 0),
  };
  await job.save();

  await persistContentUpdate(listing, {
    state: stillCurrent ? 'confirmed' : 'out_of_sync',
    desiredHash: currentDesiredHash || originalDesiredHash,
    appliedHash: originalDesiredHash,
    appliedAt: now,
    verifiedAt: now,
    canRetry: false,
    jobId: job.jobId,
    operationPath: text(job.providerOperationPath, 2048),
    operationId: text(job.providerOperationId, 160),
    lastError: '',
    lastErrorCode: '',
    recovered: recovered === true,
    stillCurrent,
  });

  return publicState(job, listing, {
    confirmed: true,
    recovered,
    stillCurrent,
    currentDesiredHash,
    deferredChangeCount: Number(currentPreview.deferredChangeCount || 0),
  });
}

async function verifyStoredPatch(listing, job, { recovered = false } = {}) {
  const patch = storedPatch(job);
  if (!Object.keys(patch).length) throw appError('commerce_allegro_content_update_job_invalid');
  const { offer } = await readOffer(listing, recovered ? 'commerce_content_update_recovery' : 'commerce_content_update_readback');
  const status = text(offer?.publication?.status, 40).toUpperCase();
  if (status !== 'ACTIVE') {
    return { matched: false, status, issues: [{ code: 'offer_not_active', message: `Offer має статус ${status || 'UNKNOWN'} замість ACTIVE.` }] };
  }
  const issues = contentPatchIssues(patch, offer);
  if (!issues.length) return { matched: true, status, result: await markConfirmed(listing, job, { recovered }) };
  return { matched: false, status, issues };
}

async function recoverUnknown(listing, job) {
  const verified = await verifyStoredPatch(listing, job, { recovered: true });
  if (verified.matched) return verified.result;

  const freshPreview = await previewAllegroOfferUpdate({
    productId: String(listing.commerceProductId),
    accountId: listing.accountId,
  });
  const originalDesiredHash = text(job?.resultSnapshot?.previewDesiredHash, 128);
  const sameDesired = Boolean(originalDesiredHash) && originalDesiredHash === text(freshPreview.desiredHash, 128);

  job.state = 'unknown';
  job.lockToken = '';
  job.providerStatus = verified.status;
  job.lastErrorCode = 'commerce_allegro_content_update_outcome_unknown';
  job.lastError = sameDesired
    ? 'Попередній content PATCH не підтверджений read-back. Автоматично не повторюємо; доступний лише явний повтор.'
    : 'Результат попереднього PATCH невідомий, а локальний контент уже змінився. Старий PATCH повторювати небезпечно.';
  await job.save();
  await persistContentUpdate(listing, {
    state: 'unknown',
    desiredHash: text(freshPreview.desiredHash, 128) || originalDesiredHash,
    appliedHash: '',
    canRetry: sameDesired,
    jobId: job.jobId,
    lastError: job.lastError,
    lastErrorCode: job.lastErrorCode,
    issues: verified.issues,
  });
  return publicState(job, listing, {
    ambiguous: true,
    canRetry: sameDesired,
    issues: verified.issues,
    message: job.lastError,
  });
}

async function refreshPending(listing, job) {
  if (!job.providerOperationPath) {
    job.state = 'unknown';
    job.lastErrorCode = 'allegro_content_update_operation_location_missing';
    job.lastError = 'Allegro повернув 202 без operation Location. PATCH не повторюємо; робимо read-back.';
    await job.save();
    return recoverUnknown(listing, job);
  }
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: job.providerOperationPath,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_content_update_operation',
  });
  job.providerTraceId = result.traceId || job.providerTraceId;
  job.providerRequestId = result.requestId || job.providerRequestId;
  if (result.status === 202 || result.pending === true || result.payload?.operation?.status === 'IN_PROGRESS') {
    job.state = 'pending';
    job.providerOperationId = text(result.payload?.operation?.id || job.providerOperationId, 160);
    await job.save();
    return publicState(job, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
  }

  const verified = await verifyStoredPatch(listing, job);
  if (verified.matched) return verified.result;
  job.state = 'failed';
  job.lockToken = '';
  job.completedAt = new Date();
  job.lastErrorCode = 'commerce_allegro_content_update_not_applied';
  job.lastError = 'Allegro operation завершилась, але content PATCH не підтверджений read-back.';
  await job.save();
  await persistContentUpdate(listing, {
    state: 'failed', canRetry: true, jobId: job.jobId,
    lastError: job.lastError, lastErrorCode: job.lastErrorCode, issues: verified.issues,
  });
  return publicState(job, listing, { canRetry: true, issues: verified.issues });
}

async function applyAllegroOfferContent(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  const retryUnknown = raw.retryUnknown === true;
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireUpdateAccount(accountId);
  let listing = await requireListing(productId, accountId);

  const unresolved = await unresolvedJob(listing);
  if (unresolved) {
    if (unresolved.state === 'pending') {
      try { return await refreshPending(listing, unresolved); } catch (error) {
        if (!errorIsAmbiguous(error)) throw error;
        return publicState(unresolved, listing, { pending: true, message: 'Не вдалося перевірити operation Allegro. PATCH не повторюємо.' });
      }
    }
    if (unresolved.state === 'sending') {
      const ageMs = Date.now() - new Date(unresolved.lastAttemptAt || unresolved.updatedAt || 0).getTime();
      if (ageMs < SENDING_STALE_MS) return publicState(unresolved, listing, { inProgress: true });
      unresolved.state = 'unknown';
      unresolved.lockToken = '';
      unresolved.lastErrorCode = 'local_content_update_outcome_unknown';
      unresolved.lastError = 'Процес перервався під час PATCH контенту ACTIVE offer.';
      await unresolved.save();
    }
    if (unresolved.state === 'unknown') {
      const recovered = await recoverUnknown(listing, unresolved);
      if (!retryUnknown || recovered.confirmed || recovered.canRetry !== true) return recovered;
      // Explicit retry is allowed only after recovery proved the same desired state
      // is still current and the previous patch is not visible in Allegro.
      unresolved.state = 'reserved';
      unresolved.completedAt = null;
      unresolved.lastError = '';
      unresolved.lastErrorCode = '';
      await unresolved.save();
    }
  }

  const preview = await previewAllegroOfferUpdate({ productId, accountId });
  if (text(preview.publicationStatus, 40).toUpperCase() !== 'ACTIVE') {
    throw appError('commerce_allegro_content_update_offer_not_active', { publicationStatus: preview.publicationStatus });
  }
  if (Number(preview.mappingChangeCount || 0) > 0) {
    throw appError('commerce_allegro_content_update_mapping_review_required');
  }
  const patch = preview.contentPatch && typeof preview.contentPatch === 'object' ? preview.contentPatch : {};
  if (!Object.keys(patch).length) {
    await persistContentUpdate(listing, {
      state: 'confirmed',
      desiredHash: text(preview.desiredHash, 128),
      appliedHash: text(preview.desiredHash, 128),
      appliedAt: new Date(),
      verifiedAt: new Date(),
      canRetry: false,
      noOp: true,
      lastError: '',
      lastErrorCode: '',
    });
    return {
      stage: '3D.4.1', provider: PROVIDER, action: ACTION, productId, accountId,
      listingId: String(listing._id), offerId: text(listing.externalId, 200), state: 'confirmed', confirmed: true, noOp: true,
      desiredHash: text(preview.desiredHash, 128), appliedHash: text(preview.desiredHash, 128),
    };
  }

  const patchHash = requestHash(patch);
  let job = await ensureJob(listing, patchHash, preview);
  if (job.state === 'confirmed') {
    const verified = await verifyStoredPatch(listing, job, { recovered: true });
    if (verified.matched) return verified.result;
  }
  const lockToken = crypto.randomUUID();
  const claimed = await CommercePublicationJob.findOneAndUpdate({
    _id: job._id,
    state: { $in: ['reserved', 'failed'] },
  }, {
    $set: {
      state: 'sending',
      lockToken,
      providerEntityId: text(listing.externalId, 200),
      lastAttemptAt: new Date(),
      lastError: '',
      lastErrorCode: '',
      lastHttpStatus: 0,
    },
    $inc: { attempts: 1 },
  }, { new: true });
  if (!claimed || claimed.lockToken !== lockToken) {
    const current = await CommercePublicationJob.findById(job._id);
    return publicState(current || job, listing, { inProgress: true });
  }

  await persistContentUpdate(listing, {
    state: 'sending',
    desiredHash: text(preview.desiredHash, 128),
    appliedHash: '',
    canRetry: false,
    jobId: claimed.jobId,
    startedAt: claimed.lastAttemptAt,
    lastError: '',
    lastErrorCode: '',
  });

  try {
    const result = await allegroRequest(accountId, {
      method: 'PATCH',
      path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
      body: patch,
      retryPolicy: 'never',
      maxAttempts: 1,
      stage: 'commerce_offer_content_update',
    });
    claimed.lockToken = '';
    claimed.providerTraceId = result.traceId || '';
    claimed.providerRequestId = result.requestId || '';
    claimed.lastHttpStatus = result.status || 0;
    claimed.providerOperationPath = apiPathFromLocation(result.location);
    claimed.providerOperationId = text(result.payload?.operation?.id || operationIdFromLocation(result.location), 160);

    if (result.status === 202 || result.pending === true) {
      claimed.state = 'pending';
      await claimed.save();
      await persistContentUpdate(listing, {
        state: 'pending', canRetry: false, jobId: claimed.jobId,
        operationPath: claimed.providerOperationPath, operationId: claimed.providerOperationId,
      });
      return publicState(claimed, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
    }

    await claimed.save();
    const verified = await verifyStoredPatch(listing, claimed);
    if (verified.matched) return verified.result;
    claimed.state = 'failed';
    claimed.completedAt = new Date();
    claimed.lastErrorCode = 'commerce_allegro_content_update_not_applied';
    claimed.lastError = 'Allegro повернув успіх, але read-back не підтвердив content PATCH.';
    await claimed.save();
    await persistContentUpdate(listing, {
      state: 'failed', canRetry: true, jobId: claimed.jobId,
      lastError: claimed.lastError, lastErrorCode: claimed.lastErrorCode, issues: verified.issues,
    });
    return publicState(claimed, listing, { canRetry: true, issues: verified.issues });
  } catch (error) {
    claimed.lockToken = '';
    claimed.lastErrorCode = text(error?.code || error?.args?.upstreamCode, 160);
    claimed.lastError = text(error?.message, 1500);
    claimed.lastHttpStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || error?.status || 0);
    claimed.state = errorIsAmbiguous(error) ? 'unknown' : 'failed';
    claimed.completedAt = claimed.state === 'failed' ? new Date() : null;
    await claimed.save();
    await persistContentUpdate(listing, {
      state: claimed.state,
      desiredHash: text(preview.desiredHash, 128),
      canRetry: claimed.state === 'failed',
      jobId: claimed.jobId,
      lastError: claimed.lastError,
      lastErrorCode: claimed.lastErrorCode,
    });
    if (claimed.state === 'unknown') {
      try { return await recoverUnknown(listing, claimed); } catch (_) { /* preserve ambiguity */ }
      return publicState(claimed, listing, { ambiguous: true, message: 'Allegro не підтвердив результат content PATCH. Автоматичний повтор заблоковано.' });
    }
    throw error;
  }
}

module.exports = {
  ACTION,
  applyAllegroOfferContent,
};
