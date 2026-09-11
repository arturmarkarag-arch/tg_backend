'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');
const { reconcileAllegroDraft } = require('./allegroDraftReconciliation');
const { salesSettingsHash, normalizeLocation } = require('./allegroSalesSettings');

const PROVIDER = 'allegro';
const ACTION = 'apply_sales_settings';
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
  const value = text(location, 2048);
  const match = value.match(/\/operations\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function savedSalesSettings(listing) {
  const providerData = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  return allegro.salesSettings && typeof allegro.salesSettings === 'object' ? allegro.salesSettings : {};
}

function buildSalesSettingsPatch(settings = {}) {
  const shippingRateId = text(settings?.shippingRate?.id, 200);
  const returnPolicyId = text(settings?.afterSalesServices?.returnPolicy?.id, 200);
  const impliedWarrantyId = text(settings?.afterSalesServices?.impliedWarranty?.id, 200);
  const warrantyId = text(settings?.afterSalesServices?.warranty?.id, 200);
  const handlingTime = text(settings?.delivery?.handlingTime, 80).toUpperCase();
  const location = normalizeLocation(settings.location || {});

  if (!settings.readyForApply || !shippingRateId || !returnPolicyId || !impliedWarrantyId || !handlingTime || !location.countryCode || !location.city) {
    throw appError('commerce_allegro_sales_settings_apply_not_ready');
  }

  return {
    delivery: {
      shippingRates: { id: shippingRateId },
      handlingTime,
    },
    afterSalesServices: {
      returnPolicy: { id: returnPolicyId },
      impliedWarranty: { id: impliedWarrantyId },
      warranty: warrantyId ? { id: warrantyId } : null,
    },
    location,
  };
}

function salesSettingsSnapshotFromOffer(offer = {}) {
  return {
    shippingRateId: text(offer?.delivery?.shippingRates?.id, 200),
    returnPolicyId: text(offer?.afterSalesServices?.returnPolicy?.id, 200),
    impliedWarrantyId: text(offer?.afterSalesServices?.impliedWarranty?.id, 200),
    warrantyId: text(offer?.afterSalesServices?.warranty?.id, 200),
    handlingTime: text(offer?.delivery?.handlingTime, 80).toUpperCase(),
    location: normalizeLocation(offer?.location || {}),
    publicationStatus: text(offer?.publication?.status, 40).toUpperCase(),
  };
}

function expectedSalesSettingsSnapshot(settings = {}) {
  const patch = buildSalesSettingsPatch(settings);
  return {
    shippingRateId: text(patch.delivery?.shippingRates?.id, 200),
    returnPolicyId: text(patch.afterSalesServices?.returnPolicy?.id, 200),
    impliedWarrantyId: text(patch.afterSalesServices?.impliedWarranty?.id, 200),
    warrantyId: text(patch.afterSalesServices?.warranty?.id, 200),
    handlingTime: text(patch.delivery?.handlingTime, 80).toUpperCase(),
    location: normalizeLocation(patch.location || {}),
  };
}

function compareSalesSettings(expected, actual) {
  const issues = [];
  const compare = (code, field, expectedValue, actualValue, message) => {
    if (String(expectedValue ?? '') === String(actualValue ?? '')) return;
    issues.push({ code, field, expected: expectedValue ?? '', actual: actualValue ?? '', message, blocking: true });
  };
  compare('shipping_rate_mismatch', 'delivery.shippingRates.id', expected.shippingRateId, actual.shippingRateId, 'Cennik dostawy в Allegro не збігається з нашим mapping.');
  compare('return_policy_mismatch', 'afterSalesServices.returnPolicy.id', expected.returnPolicyId, actual.returnPolicyId, 'Warunki zwrotu в Allegro не збігаються з нашим mapping.');
  compare('implied_warranty_mismatch', 'afterSalesServices.impliedWarranty.id', expected.impliedWarrantyId, actual.impliedWarrantyId, 'Warunki reklamacji в Allegro не збігаються з нашим mapping.');
  compare('warranty_mismatch', 'afterSalesServices.warranty.id', expected.warrantyId, actual.warrantyId, 'Gwarancja в Allegro не збігається з нашим mapping.');
  compare('handling_time_mismatch', 'delivery.handlingTime', expected.handlingTime, actual.handlingTime, 'Handling time в Allegro не збігається з нашим mapping.');
  for (const field of ['countryCode', 'province', 'city', 'postCode']) {
    compare(`location_${field}_mismatch`, `location.${field}`, expected.location?.[field], actual.location?.[field], `Локалізація ${field} в Allegro не збігається з нашим mapping.`);
  }
  return issues;
}

function idempotencyKey(listing, desiredHash) {
  return `allegro:${ACTION}:${text(listing._id, 80)}:${text(desiredHash, 128)}`;
}

async function requireApplyAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersWrite !== true || matrix.capabilities.saleOffersRead !== true) {
    throw appError('commerce_allegro_sales_settings_apply_scope_required');
  }
  return account;
}

async function requireListing(productId, accountId) {
  const id = text(productId, 80);
  if (!mongoose.isValidObjectId(id)) throw appError('commerce_product_not_found');
  const listing = await ChannelListing.findOne({ commerceProductId: id, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  if (!text(listing.externalId, 200)) throw appError('commerce_allegro_draft_not_bound');
  return listing;
}

async function ensureCurrentReconciliation(productId, accountId) {
  const reconciliation = await reconcileAllegroDraft({ productId, accountId });
  if (reconciliation.readyForNextStage !== true) {
    throw appError('commerce_allegro_sales_settings_reconciliation_required');
  }
  if (text(reconciliation?.offer?.publicationStatus, 40).toUpperCase() !== 'INACTIVE') {
    throw appError('commerce_allegro_sales_settings_offer_not_inactive', {
      publicationStatus: text(reconciliation?.offer?.publicationStatus, 40).toUpperCase(),
    });
  }
  return reconciliation;
}

async function ensureJob(listing, desiredHash) {
  const key = idempotencyKey(listing, desiredHash);
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
      requestHash: desiredHash,
      state: 'reserved',
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey: key });
  }
}

function publicApplyState(job, listing, extra = {}) {
  const row = typeof job?.toObject === 'function' ? job.toObject() : (job || {});
  const settings = savedSalesSettings(listing);
  return {
    stage: '3D.2.1',
    provider: PROVIDER,
    action: ACTION,
    productId: String(row.commerceProductId || listing?.commerceProductId || ''),
    accountId: text(row.accountId || listing?.accountId, 80),
    listingId: String(row.channelListingId || listing?._id || ''),
    offerId: text(row.providerEntityId || listing?.externalId, 200),
    jobId: text(row.jobId, 80),
    state: text(row.state, 40) || text(settings.state, 40) || 'reserved',
    desiredHash: text(settings.desiredHash || row.requestHash, 128),
    appliedHash: text(settings.appliedHash, 128),
    readyForActivation: settings.readyForActivation === true,
    operationPath: text(row.providerOperationPath, 2048),
    attempts: Number(row.attempts || 0),
    lastErrorCode: text(row.lastErrorCode, 160),
    lastError: text(row.lastError, 1500),
    lastHttpStatus: Number(row.lastHttpStatus || 0),
    ...extra,
  };
}

async function persistSettingsState(listing, patch = {}) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  const current = savedSalesSettings(listing);
  const currentApply = current.apply && typeof current.apply === 'object' ? current.apply : {};
  providerData.allegro = {
    ...allegro,
    salesSettings: {
      ...current,
      ...patch,
      apply: {
        ...currentApply,
        ...(patch.apply && typeof patch.apply === 'object' ? patch.apply : {}),
      },
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  if (patch.syncState) {
    listing.syncState = {
      ...(listing.syncState?.toObject?.() || listing.syncState || {}),
      ...patch.syncState,
    };
    delete providerData.allegro.salesSettings.syncState;
  }
  await listing.save();
}

async function markJobFailure(job, error, state) {
  job.state = state;
  job.lockToken = '';
  job.lastErrorCode = text(error?.code || error?.args?.upstreamCode, 160);
  job.lastError = text(error?.message, 1500);
  job.lastHttpStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || error?.status || 0);
  await job.save();
}

function errorIsAmbiguous(error) {
  const code = text(error?.code, 160);
  if (['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code)) return true;
  const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
  return status === 408 || status === 425 || status >= 500;
}

async function confirmApplied({ listing, job, offer, recovered = false, onMismatch = 'failed' }) {
  const settings = savedSalesSettings(listing);
  const expected = expectedSalesSettingsSnapshot(settings);
  const actual = salesSettingsSnapshotFromOffer(offer);
  const issues = compareSalesSettings(expected, actual);
  if (actual.publicationStatus !== 'INACTIVE') {
    issues.push({
      code: 'offer_not_inactive',
      field: 'publication.status',
      expected: 'INACTIVE',
      actual: actual.publicationStatus,
      message: 'Offer більше не INACTIVE. Автоматичний перехід до Stage 3D.3 заблоковано.',
      blocking: true,
    });
  }
  const now = new Date();
  const desiredHash = text(settings.desiredHash || job.requestHash, 128);

  if (issues.length) {
    const message = issues.map((item) => item.message).slice(0, 4).join(' · ');
    if (onMismatch === 'observe') {
      return publicApplyState(job, listing, { confirmed: false, issues, expected, actual, recovered, observedOnly: true });
    }
    const keepUnknown = onMismatch === 'unknown';
    job.state = keepUnknown ? 'unknown' : 'failed';
    job.lockToken = '';
    job.providerEntityId = text(offer?.id || listing.externalId, 200);
    job.providerStatus = actual.publicationStatus;
    job.completedAt = keepUnknown ? null : now;
    job.lastErrorCode = keepUnknown ? 'commerce_allegro_sales_settings_apply_outcome_unknown' : 'commerce_allegro_sales_settings_apply_mismatch';
    job.lastError = message;
    job.resultSnapshot = { expected, actual, issues, recovered };
    await job.save();
    await persistSettingsState(listing, {
      state: keepUnknown ? 'unknown' : 'drift',
      readyForActivation: false,
      verifiedAt: now,
      apply: {
        state: keepUnknown ? 'unknown' : 'failed',
        jobId: job.jobId,
        operationPath: text(job.providerOperationPath, 2048),
        operationId: text(job.providerOperationId, 160),
        issues,
        lastError: message,
        lastErrorCode: job.lastErrorCode,
      },
      syncState: { state: keepUnknown ? 'unknown' : 'out_of_sync', lastError: message },
    });
    return publicApplyState(job, listing, { confirmed: false, issues, expected, actual, recovered, ambiguous: keepUnknown });
  }

  job.state = 'confirmed';
  job.lockToken = '';
  job.providerEntityId = text(offer?.id || listing.externalId, 200);
  job.providerStatus = actual.publicationStatus;
  job.completedAt = now;
  job.lastError = '';
  job.lastErrorCode = '';
  job.lastHttpStatus = 0;
  job.resultSnapshot = { expected, actual, issues: [], recovered };
  await job.save();

  await persistSettingsState(listing, {
    state: 'applied',
    readyForApply: true,
    readyForActivation: true,
    appliedHash: desiredHash,
    appliedAt: now,
    verifiedAt: now,
    apply: {
      state: 'confirmed',
      jobId: job.jobId,
      operationPath: text(job.providerOperationPath, 2048),
      operationId: text(job.providerOperationId, 160),
      issues: [],
      lastError: '',
      lastErrorCode: '',
      recovered: recovered === true,
    },
    syncState: { state: 'in_sync', lastSyncAt: now, lastError: '' },
  });
  return publicApplyState(job, listing, { confirmed: true, issues: [], expected, actual, recovered });
}

async function readAndVerifyOffer(listing, job, recovered = false, onMismatch = 'failed') {
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_sales_settings_verify',
  });
  job.providerTraceId = result.traceId || job.providerTraceId;
  job.providerRequestId = result.requestId || job.providerRequestId;
  if (!result.payload?.id) throw appError('commerce_allegro_sales_settings_apply_response_invalid');
  return confirmApplied({ listing, job, offer: result.payload, recovered, onMismatch });
}

async function refreshPendingOperation(listing, job) {
  if (!job.providerOperationPath) return null;
  const result = await allegroRequest(listing.accountId, {
    method: 'GET',
    path: job.providerOperationPath,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_sales_settings_operation',
  });
  job.providerTraceId = result.traceId || job.providerTraceId;
  job.providerRequestId = result.requestId || job.providerRequestId;
  if (result.status === 202 || result.pending === true || result.payload?.operation?.status === 'IN_PROGRESS') {
    job.state = 'pending';
    job.providerOperationId = text(result.payload?.operation?.id || job.providerOperationId, 160);
    await job.save();
    await persistSettingsState(listing, {
      state: 'pending',
      readyForActivation: false,
      apply: { state: 'pending', jobId: job.jobId, operationPath: job.providerOperationPath, operationId: job.providerOperationId },
      syncState: { state: 'pending', lastError: '' },
    });
    return publicApplyState(job, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
  }
  // node fetch follows Allegro 303 to the current product-offer resource.
  if (result.payload?.id) return confirmApplied({ listing, job, offer: result.payload });
  return null;
}

async function applyAllegroSalesSettings(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireApplyAccount(accountId);
  let listing = await requireListing(productId, accountId);
  let settings = savedSalesSettings(listing);
  if (settings.readyForApply !== true || !text(settings.desiredHash, 128)) {
    throw appError('commerce_allegro_sales_settings_apply_not_ready');
  }
  const canonicalHash = salesSettingsHash(settings);
  if (canonicalHash !== text(settings.desiredHash, 128)) {
    throw appError('commerce_allegro_sales_settings_apply_hash_mismatch');
  }
  const desiredHash = canonicalHash;

  // Reconcile the core draft immediately before the write. Do it only after the
  // local settings contract is valid, otherwise a failed local apply must not
  // accidentally make ChannelListing.syncState look in-sync.
  await ensureCurrentReconciliation(productId, accountId);
  listing = await requireListing(productId, accountId);
  settings = savedSalesSettings(listing);
  if (settings.readyForApply !== true || text(settings.desiredHash, 128) !== desiredHash || salesSettingsHash(settings) !== desiredHash) {
    throw appError('commerce_allegro_sales_settings_apply_hash_mismatch');
  }
  const job = await ensureJob(listing, desiredHash);

  if (job.state === 'confirmed' && text(settings.appliedHash, 128) === desiredHash && settings.readyForActivation === true) {
    return publicApplyState(job, listing, { alreadyApplied: true, confirmed: true });
  }
  if (job.state === 'pending') {
    if (!job.providerOperationPath) {
      job.state = 'unknown';
      job.lastErrorCode = 'allegro_operation_location_missing';
      job.lastError = 'Allegro повернув 202 без operation Location; повтор PATCH заблоковано до recovery.';
      await job.save();
      await persistSettingsState(listing, {
        state: 'unknown', readyForActivation: false,
        apply: { state: 'unknown', jobId: job.jobId, lastError: job.lastError, lastErrorCode: job.lastErrorCode },
        syncState: { state: 'unknown', lastError: job.lastError },
      });
    } else {
      try {
        const refreshed = await refreshPendingOperation(listing, job);
        if (refreshed) return refreshed;
      } catch (error) {
        if (!errorIsAmbiguous(error)) throw error;
        job.lastErrorCode = text(error?.code, 160);
        job.lastError = text(error?.message, 1500);
        await job.save();
        return publicApplyState(job, listing, {
          pending: true, ambiguousPoll: true,
          message: 'Не вдалося перевірити асинхронну operation Allegro. PATCH не повторюємо; спробуйте «Перевірити Allegro» ще раз.',
        });
      }
    }
  }
  if (job.state === 'unknown') {
    const verified = await readAndVerifyOffer(listing, job, true, 'unknown');
    if (verified.confirmed) return verified;
    return publicApplyState(job, listing, {
      ambiguous: true,
      message: 'Попередній PATCH має невідомий результат. Повтор заблоковано; використайте «Перевірити Allegro».',
    });
  }
  if (job.state === 'sending') {
    const ageMs = Date.now() - new Date(job.lastAttemptAt || job.updatedAt || 0).getTime();
    if (ageMs < SENDING_STALE_MS) return publicApplyState(job, listing, { inProgress: true });
    job.state = 'unknown';
    job.lockToken = '';
    job.lastErrorCode = 'local_apply_outcome_unknown';
    job.lastError = 'Процес перервався під час PATCH /sale/product-offers/{offerId}; повтор заблоковано до recovery.';
    await job.save();
    await persistSettingsState(listing, {
      state: 'unknown',
      readyForActivation: false,
      apply: { state: 'unknown', jobId: job.jobId, lastError: job.lastError, lastErrorCode: job.lastErrorCode },
      syncState: { state: 'unknown', lastError: job.lastError },
    });
    const verified = await readAndVerifyOffer(listing, job, true, 'unknown');
    if (verified.confirmed) return verified;
    return publicApplyState(job, listing, { ambiguous: true });
  }

  // Read-before-write gives us idempotent recovery when a prior completed PATCH
  // was persisted in Allegro but not in our database.
  const precheck = await readAndVerifyOffer(listing, job, true, 'observe');
  if (precheck.confirmed) return precheck;
  if (text(precheck?.actual?.publicationStatus, 40).toUpperCase() !== 'INACTIVE') {
    throw appError('commerce_allegro_sales_settings_offer_not_inactive', {
      publicationStatus: text(precheck?.actual?.publicationStatus, 40).toUpperCase(),
    });
  }

  // A mismatch is expected before first apply; the observe-only precheck does
  // not mutate the durable job or make an ambiguous PATCH retryable.
  // Re-open the durable job for the controlled PATCH below.
  job.state = 'reserved';
  job.completedAt = null;
  job.lastErrorCode = '';
  job.lastError = '';
  job.resultSnapshot = {};
  await job.save();
  listing = await requireListing(productId, accountId);

  const lockToken = crypto.randomUUID();
  const claimed = await CommercePublicationJob.findOneAndUpdate({
    _id: job._id,
    state: { $in: ['reserved', 'failed'] },
  }, {
    $set: {
      state: 'sending',
      lockToken,
      requestHash: desiredHash,
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
    return publicApplyState(current || job, listing, { inProgress: true });
  }

  await persistSettingsState(listing, {
    state: 'sending',
    readyForActivation: false,
    apply: { state: 'sending', jobId: claimed.jobId, startedAt: claimed.lastAttemptAt },
    syncState: { state: 'pending', lastError: '' },
  });

  const patch = buildSalesSettingsPatch(savedSalesSettings(listing));
  try {
    // No automatic retry here. A transport failure can hide a PATCH that Allegro
    // accepted; recovery first reads the offer and only a new explicit action may retry.
    const result = await allegroRequest(accountId, {
      method: 'PATCH',
      path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
      body: patch,
      retryPolicy: 'never',
      maxAttempts: 1,
      stage: 'commerce_sales_settings_apply',
    });
    claimed.lockToken = '';
    claimed.providerTraceId = result.traceId || '';
    claimed.providerRequestId = result.requestId || '';
    claimed.lastHttpStatus = result.status || 0;
    claimed.providerOperationPath = apiPathFromLocation(result.location);
    claimed.providerOperationId = text(result.payload?.operation?.id || operationIdFromLocation(result.location), 160);

    if (result.status === 202 || result.pending === true) {
      claimed.state = 'pending';
      claimed.providerStatus = 'PROCESSING';
      await claimed.save();
      await persistSettingsState(listing, {
        state: 'pending',
        readyForActivation: false,
        apply: {
          state: 'pending',
          jobId: claimed.jobId,
          operationPath: claimed.providerOperationPath,
          operationId: claimed.providerOperationId,
        },
        syncState: { state: 'pending', lastError: '' },
      });
      return publicApplyState(claimed, listing, { pending: true, retryAfterMs: result.retryAfterMs || 0 });
    }

    // Requirement of Stage 3D.2.1: always read the offer back after a synchronous
    // success instead of trusting only the PATCH response body.
    return readAndVerifyOffer(listing, claimed, false);
  } catch (error) {
    claimed.lockToken = '';
    if (errorIsAmbiguous(error)) {
      await markJobFailure(claimed, error, 'unknown');
      await persistSettingsState(listing, {
        state: 'unknown',
        readyForActivation: false,
        apply: { state: 'unknown', jobId: claimed.jobId, lastError: claimed.lastError, lastErrorCode: claimed.lastErrorCode },
        syncState: { state: 'unknown', lastError: claimed.lastError },
      });
      // One immediate GET can recover a PATCH accepted before the transport died.
      try {
        const verified = await readAndVerifyOffer(listing, claimed, true, 'unknown');
        if (verified.confirmed) return verified;
      } catch (_) { /* preserve original ambiguity */ }
      return publicApplyState(claimed, listing, {
        ambiguous: true,
        message: 'Allegro не підтвердив результат PATCH. Автоматичний повтор заблоковано до recovery.',
      });
    }
    await markJobFailure(claimed, error, 'failed');
    await persistSettingsState(listing, {
      state: 'failed',
      readyForActivation: false,
      apply: { state: 'failed', jobId: claimed.jobId, lastError: claimed.lastError, lastErrorCode: claimed.lastErrorCode },
      syncState: { state: 'failed', lastError: claimed.lastError },
    });
    throw error;
  }
}

async function refreshAllegroSalesSettingsApply(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireApplyAccount(accountId);
  const listing = await requireListing(productId, accountId);
  const settings = savedSalesSettings(listing);
  const desiredHash = text(settings.desiredHash, 128);
  if (!settings.readyForApply || !desiredHash) throw appError('commerce_allegro_sales_settings_apply_not_ready');
  const job = await ensureJob(listing, desiredHash);

  if (job.state === 'confirmed' && text(settings.appliedHash, 128) === desiredHash && settings.readyForActivation === true) {
    return publicApplyState(job, listing, { alreadyApplied: true, confirmed: true });
  }
  if (job.state === 'pending') {
    if (!job.providerOperationPath) {
      job.state = 'unknown';
      job.lastErrorCode = 'allegro_operation_location_missing';
      job.lastError = 'Allegro повернув 202 без operation Location; результат PATCH невідомий.';
      await job.save();
    } else {
      try {
        const refreshed = await refreshPendingOperation(listing, job);
        if (refreshed) return refreshed;
      } catch (error) {
        if (!errorIsAmbiguous(error)) {
          await markJobFailure(job, error, 'failed');
          await persistSettingsState(listing, {
            state: 'failed', readyForActivation: false,
            apply: { state: 'failed', jobId: job.jobId, lastError: job.lastError, lastErrorCode: job.lastErrorCode },
            syncState: { state: 'failed', lastError: job.lastError },
          });
          throw error;
        }
        // Allegro explicitly requires polling the operation after 202. A failed
        // poll must not be replaced by GET offer because the async change may
        // still complete later and a stale offer snapshot is not proof of failure.
        job.lastErrorCode = text(error?.code, 160);
        job.lastError = text(error?.message, 1500);
        await job.save();
        await persistSettingsState(listing, {
          state: 'pending', readyForActivation: false,
          apply: { state: 'pending', jobId: job.jobId, operationPath: job.providerOperationPath, operationId: job.providerOperationId, lastError: job.lastError, lastErrorCode: job.lastErrorCode },
          syncState: { state: 'pending', lastError: job.lastError },
        });
        return publicApplyState(job, listing, {
          pending: true, ambiguousPoll: true,
          message: 'Operation Allegro ще не підтверджена. PATCH не повторюємо; повторіть перевірку operation.',
        });
      }
    }
  }

  const mismatchMode = ['unknown', 'sending'].includes(job.state) ? 'unknown' : 'failed';
  const verified = await readAndVerifyOffer(listing, job, true, mismatchMode);
  if (verified.confirmed) return verified;
  if (job.state === 'sending') {
    job.state = 'unknown';
    job.lockToken = '';
    job.lastErrorCode = 'local_apply_outcome_unknown';
    job.lastError = 'Немає підтвердження завершення PATCH Sales Settings.';
    await job.save();
  }
  await persistSettingsState(listing, {
    state: job.state === 'failed' ? 'drift' : 'unknown',
    readyForActivation: false,
    apply: { state: job.state === 'failed' ? 'failed' : 'unknown', jobId: job.jobId, lastError: job.lastError, lastErrorCode: job.lastErrorCode },
    syncState: { state: job.state === 'failed' ? 'out_of_sync' : 'unknown', lastError: job.lastError },
  });
  return publicApplyState(job, listing, {
    ambiguous: job.state !== 'failed',
    message: job.state === 'failed'
      ? 'Sales Settings у Allegro не збігаються з нашим mapping.'
      : 'PATCH ще не підтверджено. Offer перевірено, але потрібні значення ще не застосовані.',
  });
}

module.exports = {
  ACTION,
  applyAllegroSalesSettings,
  buildSalesSettingsPatch,
  compareSalesSettings,
  refreshAllegroSalesSettingsApply,
  salesSettingsSnapshotFromOffer,
};
