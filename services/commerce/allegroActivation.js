'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');
const { previewPublication } = require('./publicationPreview');
const { reconcileAllegroDraft } = require('./allegroDraftReconciliation');
const {
  buildSalesSettingsPatch,
  compareSalesSettings,
  salesSettingsSnapshotFromOffer,
} = require('./allegroSalesSettingsApply');

const PROVIDER = 'allegro';
const ACTION = 'activate_offer';
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

function savedSalesSettings(listing) {
  const allegro = savedAllegro(listing);
  return allegro.salesSettings && typeof allegro.salesSettings === 'object' ? allegro.salesSettings : {};
}

function activationKey(listing) {
  return `allegro:${ACTION}:${text(listing._id, 80)}`;
}

async function requireActivationAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true || matrix.capabilities.saleOffersWrite !== true) {
    throw appError('commerce_allegro_activation_scope_required');
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

async function ensureJob(listing) {
  const key = activationKey(listing);
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
      state: 'reserved',
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey: key });
  }
}

async function persistActivation(listing, patch = {}, syncPatch = null) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...allegro,
    activation: {
      ...(allegro.activation && typeof allegro.activation === 'object' ? allegro.activation : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  if (syncPatch) {
    listing.syncState = {
      ...(listing.syncState?.toObject?.() || listing.syncState || {}),
      ...syncPatch,
    };
  }
  await listing.save();
}

function publicActivation(job, listing, extra = {}) {
  const row = typeof job?.toObject === 'function' ? job.toObject() : (job || {});
  const activation = savedAllegro(listing).activation || {};
  return {
    stage: '3D.3',
    provider: PROVIDER,
    action: ACTION,
    productId: String(row.commerceProductId || listing?.commerceProductId || ''),
    accountId: text(row.accountId || listing?.accountId, 80),
    listingId: String(row.channelListingId || listing?._id || ''),
    offerId: text(row.providerEntityId || listing?.externalId, 200),
    jobId: text(row.jobId, 80),
    state: text(row.state, 40) || text(activation.state, 40) || 'reserved',
    publicationStatus: text(row.providerStatus || activation.publicationStatus, 40).toUpperCase(),
    operationPath: text(row.providerOperationPath, 2048),
    attempts: Number(row.attempts || 0),
    lastErrorCode: text(row.lastErrorCode, 160),
    lastError: text(row.lastError, 1500),
    canRetry: activation.canRetry === true,
    ...extra,
  };
}

function errorIsAmbiguous(error) {
  const code = text(error?.code, 160);
  if (['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code)) return true;
  const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
  return status === 408 || status === 425 || status >= 500;
}

async function readOffer(listing, stage = 'commerce_activation_verify') {
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage,
  });
  if (!text(result.payload?.id, 200)) throw appError('commerce_allegro_activation_response_invalid');
  return { result, offer: result.payload };
}

function salesSettingsExpectedSnapshot(settings) {
  const patch = buildSalesSettingsPatch(settings);
  return salesSettingsSnapshotFromOffer({ ...patch, publication: { status: 'INACTIVE' } });
}

function salesSettingsIssues(settings, offer) {
  const expected = salesSettingsExpectedSnapshot(settings);
  const actual = salesSettingsSnapshotFromOffer(offer);
  return { expected, actual, issues: compareSalesSettings(expected, actual) };
}

async function ensureFinalGate(productId, accountId) {
  const preview = await previewPublication({
    productIds: [productId],
    targets: [{ provider: PROVIDER, accountId }],
  });
  const row = preview.rows?.[0];
  const blocking = (row?.issues || []).filter((issue) => issue.level === 'error');
  if (!row?.ready || blocking.length) {
    throw appError('commerce_allegro_activation_preflight_failed', {
      issues: blocking.map((issue) => issue.message).slice(0, 10),
    });
  }

  const reconciliation = await reconcileAllegroDraft({ productId, accountId });
  if (reconciliation.readyForNextStage !== true || text(reconciliation?.offer?.publicationStatus, 40).toUpperCase() !== 'INACTIVE') {
    throw appError('commerce_allegro_activation_reconciliation_required');
  }

  const listing = await requireListing(productId, accountId);
  const settings = savedSalesSettings(listing);
  if (
    settings.readyForActivation !== true
    || !text(settings.desiredHash, 128)
    || text(settings.desiredHash, 128) !== text(settings.appliedHash, 128)
    || text(settings?.apply?.state, 40) !== 'confirmed'
  ) {
    throw appError('commerce_allegro_activation_sales_settings_required');
  }

  // Final read-back protects the activation boundary from Sales Settings drift
  // that may have happened after Stage 3D.2.1 was confirmed.
  const { offer } = await readOffer(listing, 'commerce_activation_final_gate');
  const status = text(offer?.publication?.status, 40).toUpperCase();
  if (status === 'ACTIVE') return { listing, offer, alreadyActive: true };
  if (status !== 'INACTIVE') throw appError('commerce_allegro_activation_offer_not_inactive', { publicationStatus: status });
  const compared = salesSettingsIssues(settings, offer);
  if (compared.issues.length) {
    throw appError('commerce_allegro_activation_sales_settings_drift', {
      issues: compared.issues.map((item) => item.message).slice(0, 10),
    });
  }
  return { listing, offer, alreadyActive: false };
}

async function confirmActive(listing, job, offer, recovered = false) {
  const status = text(offer?.publication?.status, 40).toUpperCase();
  const now = new Date();
  job.providerEntityId = text(offer?.id || listing.externalId, 200);
  job.providerStatus = status;

  if (status === 'ACTIVE') {
    job.state = 'confirmed';
    job.lockToken = '';
    job.completedAt = now;
    job.lastError = '';
    job.lastErrorCode = '';
    job.resultSnapshot = { publicationStatus: status, recovered };
    await job.save();
    listing.status = 'active';
    await persistActivation(listing, {
      state: 'confirmed',
      publicationStatus: 'ACTIVE',
      activatedAt: now,
      verifiedAt: now,
      canRetry: false,
      jobId: job.jobId,
      operationPath: text(job.providerOperationPath, 2048),
      operationId: text(job.providerOperationId, 160),
      lastError: '',
      lastErrorCode: '',
      recovered: recovered === true,
    }, { state: 'in_sync', lastSyncAt: now, lastError: '' });
    return publicActivation(job, listing, { confirmed: true, recovered });
  }

  if (status === 'ACTIVATING') {
    job.state = job.providerOperationPath ? 'pending' : 'unknown';
    job.lockToken = '';
    job.lastErrorCode = job.providerOperationPath ? '' : 'allegro_activation_operation_unknown';
    job.lastError = job.providerOperationPath ? '' : 'Offer має статус ACTIVATING, але operation URL невідомий. PATCH не повторюємо.';
    await job.save();
    listing.status = 'publishing';
    await persistActivation(listing, {
      state: job.state,
      publicationStatus: 'ACTIVATING',
      canRetry: false,
      jobId: job.jobId,
      operationPath: text(job.providerOperationPath, 2048),
      operationId: text(job.providerOperationId, 160),
      lastError: job.lastError,
      lastErrorCode: job.lastErrorCode,
    }, { state: job.state === 'pending' ? 'pending' : 'unknown', lastError: job.lastError });
    return publicActivation(job, listing, { pending: true, recovered });
  }

  return publicActivation(job, listing, {
    confirmed: false,
    observedOnly: true,
    publicationStatus: status,
  });
}

async function markActivationFailed(listing, job, status, message) {
  const now = new Date();
  job.state = 'failed';
  job.lockToken = '';
  job.providerStatus = text(status, 40).toUpperCase();
  job.completedAt = now;
  job.lastErrorCode = 'commerce_allegro_activation_not_active';
  job.lastError = text(message, 1500);
  await job.save();
  listing.status = 'draft';
  await persistActivation(listing, {
    state: 'failed',
    publicationStatus: job.providerStatus,
    canRetry: true,
    jobId: job.jobId,
    lastError: job.lastError,
    lastErrorCode: job.lastErrorCode,
  }, { state: 'failed', lastError: job.lastError });
  return publicActivation(job, listing, { canRetry: true });
}

async function refreshPendingOperation(listing, job) {
  if (!job.providerOperationPath) {
    job.state = 'unknown';
    job.lastErrorCode = 'allegro_activation_operation_location_missing';
    job.lastError = 'Allegro повернув 202 без operation Location. PATCH не повторюємо; перевіряємо фактичний offer.';
    await job.save();
    return recoverActivation(listing, job);
  }
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: job.providerOperationPath,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_activation_operation',
  });
  job.providerTraceId = result.traceId || job.providerTraceId;
  job.providerRequestId = result.requestId || job.providerRequestId;
  if (result.status === 202 || result.pending === true || result.payload?.operation?.status === 'IN_PROGRESS') {
    job.state = 'pending';
    job.providerOperationId = text(result.payload?.operation?.id || job.providerOperationId, 160);
    await job.save();
    return publicActivation(job, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
  }
  let offer = result.payload?.id ? result.payload : null;
  if (!offer) ({ offer } = await readOffer(listing, 'commerce_activation_operation_readback'));
  const confirmed = await confirmActive(listing, job, offer);
  if (confirmed.confirmed || confirmed.pending) return confirmed;
  return markActivationFailed(
    listing,
    job,
    confirmed.publicationStatus,
    `Allegro operation завершилась, але offer має статус ${confirmed.publicationStatus || 'UNKNOWN'} замість ACTIVE.`,
  );
}

async function recoverActivation(listing, job) {
  const { offer } = await readOffer(listing, 'commerce_activation_recovery');
  const status = text(offer?.publication?.status, 40).toUpperCase();
  if (status === 'ACTIVE' || status === 'ACTIVATING') return confirmActive(listing, job, offer, true);
  if (status === 'INACTIVE') {
    job.state = 'unknown';
    job.lockToken = '';
    job.providerStatus = status;
    await job.save();
    await persistActivation(listing, {
      state: 'unknown',
      publicationStatus: 'INACTIVE',
      canRetry: true,
      jobId: job.jobId,
      lastError: 'Попередня активація не підтверджена, а offer зараз INACTIVE. Можна виконати явний повтор після перевірки.',
      lastErrorCode: 'commerce_allegro_activation_outcome_unknown',
    }, { state: 'unknown', lastError: 'Результат попередньої активації не підтверджено.' });
    return publicActivation(job, listing, {
      ambiguous: true,
      canRetry: true,
      message: 'Offer зараз INACTIVE, але попередній PATCH мав невідомий результат. Автоматично не повторюємо; доступний лише явний повтор.',
    });
  }
  throw appError('commerce_allegro_activation_offer_not_inactive', { publicationStatus: status });
}

async function activateAllegroOffer(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  const retryUnknown = raw.retryUnknown === true;
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireActivationAccount(accountId);
  let listing = await requireListing(productId, accountId);
  let job = await ensureJob(listing);

  if (job.state === 'confirmed') {
    const { offer } = await readOffer(listing, 'commerce_activation_confirmed_readback');
    return confirmActive(listing, job, offer, true);
  }

  if (job.state === 'pending') {
    try {
      const refreshed = await refreshPendingOperation(listing, job);
      if (refreshed) return refreshed;
    } catch (error) {
      if (!errorIsAmbiguous(error)) throw error;
      return publicActivation(job, listing, {
        pending: true,
        message: 'Не вдалося перевірити operation Allegro. PATCH не повторюємо; повторіть перевірку.',
      });
    }
  }

  if (job.state === 'sending') {
    const ageMs = Date.now() - new Date(job.lastAttemptAt || job.updatedAt || 0).getTime();
    if (ageMs < SENDING_STALE_MS) return publicActivation(job, listing, { inProgress: true });
    job.state = 'unknown';
    job.lockToken = '';
    job.lastErrorCode = 'local_activation_outcome_unknown';
    job.lastError = 'Процес перервався під час PATCH publication.status=ACTIVE.';
    await job.save();
  }

  if (job.state === 'unknown' && !retryUnknown) return recoverActivation(listing, job);

  if (job.state === 'unknown' && retryUnknown) {
    const recovered = await recoverActivation(listing, job);
    if (recovered.confirmed || recovered.pending || recovered.publicationStatus === 'ACTIVATING') return recovered;
    if (recovered.canRetry !== true) return recovered;
    // Explicit user retry is allowed only after a fresh read proved INACTIVE.
    job.state = 'reserved';
    job.completedAt = null;
    job.lastError = '';
    job.lastErrorCode = '';
    await job.save();
  }

  const gate = await ensureFinalGate(productId, accountId);
  listing = gate.listing;
  if (gate.alreadyActive) return confirmActive(listing, job, gate.offer, true);

  const requestHash = crypto.createHash('sha256')
    .update(JSON.stringify({ offerId: listing.externalId, publication: { status: 'ACTIVE' } }), 'utf8')
    .digest('hex');
  const lockToken = crypto.randomUUID();
  const claimed = await CommercePublicationJob.findOneAndUpdate({
    _id: job._id,
    state: { $in: ['reserved', 'failed'] },
  }, {
    $set: {
      state: 'sending',
      lockToken,
      requestHash,
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
    return publicActivation(current || job, listing, { inProgress: true });
  }

  listing.status = 'publishing';
  await persistActivation(listing, {
    state: 'sending',
    publicationStatus: 'INACTIVE',
    canRetry: false,
    jobId: claimed.jobId,
    startedAt: claimed.lastAttemptAt,
    lastError: '',
    lastErrorCode: '',
  }, { state: 'pending', lastError: '' });

  try {
    // This is deliberately the smallest possible Allegro write. Do not combine
    // activation with price/stock/content edits; those belong to later stages.
    const result = await allegroRequest(accountId, {
      method: 'PATCH',
      path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
      body: { publication: { status: 'ACTIVE' } },
      retryPolicy: 'never',
      maxAttempts: 1,
      stage: 'commerce_offer_activation',
    });
    claimed.lockToken = '';
    claimed.providerTraceId = result.traceId || '';
    claimed.providerRequestId = result.requestId || '';
    claimed.lastHttpStatus = result.status || 0;
    claimed.providerOperationPath = apiPathFromLocation(result.location);
    claimed.providerOperationId = text(result.payload?.operation?.id || operationIdFromLocation(result.location), 160);

    if (result.status === 202 || result.pending === true) {
      claimed.state = 'pending';
      claimed.providerStatus = 'ACTIVATING';
      await claimed.save();
      await persistActivation(listing, {
        state: 'pending',
        publicationStatus: 'ACTIVATING',
        canRetry: false,
        jobId: claimed.jobId,
        operationPath: claimed.providerOperationPath,
        operationId: claimed.providerOperationId,
      }, { state: 'pending', lastError: '' });
      return publicActivation(claimed, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
    }

    const { offer } = await readOffer(listing, 'commerce_activation_readback');
    const confirmed = await confirmActive(listing, claimed, offer);
    if (confirmed.confirmed || confirmed.pending) return confirmed;
    return markActivationFailed(
      listing,
      claimed,
      confirmed.publicationStatus,
      `Allegro завершив PATCH, але offer має статус ${confirmed.publicationStatus || 'UNKNOWN'}.`,
    );
  } catch (error) {
    claimed.lockToken = '';
    claimed.lastErrorCode = text(error?.code || error?.args?.upstreamCode, 160);
    claimed.lastError = text(error?.message, 1500);
    claimed.lastHttpStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || error?.status || 0);
    claimed.state = errorIsAmbiguous(error) ? 'unknown' : 'failed';
    claimed.completedAt = claimed.state === 'failed' ? new Date() : null;
    await claimed.save();
    listing.status = 'draft';
    await persistActivation(listing, {
      state: claimed.state,
      publicationStatus: 'INACTIVE',
      canRetry: claimed.state === 'failed',
      jobId: claimed.jobId,
      lastError: claimed.lastError,
      lastErrorCode: claimed.lastErrorCode,
    }, { state: claimed.state === 'failed' ? 'failed' : 'unknown', lastError: claimed.lastError });
    if (claimed.state === 'unknown') {
      try { return await recoverActivation(listing, claimed); } catch (_) { /* preserve ambiguity */ }
      return publicActivation(claimed, listing, {
        ambiguous: true,
        message: 'Allegro не підтвердив результат активації. Автоматичний повтор заблоковано до read-back.',
      });
    }
    throw error;
  }
}

module.exports = {
  ACTION,
  activateAllegroOffer,
  ensureFinalGate,
  salesSettingsIssues,
};
