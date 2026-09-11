'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');
const { previewAllegroStockSync } = require('./allegroStockSync');

const PROVIDER = 'allegro';
const PUBLIC_MIME = 'application/vnd.allegro.public.v1+json';
const ACTION_END = 'lifecycle_end';
const ACTION_REOPEN = 'lifecycle_reopen';

function text(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function whole(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
function requestHash(value) { return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
function upstreamStatus(error) { return Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0); }
function ambiguous(error) {
  const code = text(error?.code, 160);
  const status = upstreamStatus(error);
  return ['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code) || status === 408 || status === 425 || status >= 500;
}
function lifecycleData(listing) {
  const pd = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = pd.allegro && typeof pd.allegro === 'object' ? pd.allegro : {};
  return allegro.lifecycle && typeof allegro.lifecycle === 'object' ? allegro.lifecycle : {};
}
function generation(listing) { return Math.max(0, Number(lifecycleData(listing).generation || 0)); }

async function requireAccount(accountId, write = false) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true || (write && matrix.capabilities.saleOffersWrite !== true)) {
    throw appError('commerce_allegro_lifecycle_scope_required');
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

async function readOffer(listing, stage = 'commerce_lifecycle_read') {
  try {
    const result = await allegroRequest(listing.accountId, {
      method: 'GET',
      path: `/sale/product-offers/${encodeURIComponent(listing.externalId)}`,
      retryPolicy: 'safe',
      maxAttempts: 3,
      stage,
      accept: PUBLIC_MIME,
    });
    if (!text(result.payload?.id, 200)) throw appError('commerce_allegro_lifecycle_response_invalid');
    return { result, offer: result.payload };
  } catch (error) {
    if (upstreamStatus(error) === 404) throw appError('commerce_allegro_lifecycle_offer_missing');
    throw error;
  }
}

function publicationStatus(offer) { return text(offer?.publication?.status, 40).toUpperCase(); }
function sellingFormat(offer) { return text(offer?.sellingMode?.format, 40).toUpperCase(); }
function offerStock(offer) { return whole(offer?.stock?.available); }

async function lifecyclePreview(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');
  await requireAccount(accountId, false);
  const listing = await requireListing(productId, accountId);
  const [{ offer }, stockPreview] = await Promise.all([
    readOffer(listing, 'commerce_lifecycle_preview_offer'),
    previewAllegroStockSync({ items: [{ productId, accountId }] }),
  ]);
  const stockRow = stockPreview.rows?.[0] || null;
  const status = publicationStatus(offer);
  const format = sellingFormat(offer);
  const desiredStock = whole(stockRow?.desiredStock?.available);
  const actualStock = offerStock(offer);
  const blockingStockErrors = (stockRow?.errors || []).filter((item) => item.code !== 'offer_reactivation_required');
  const commerceStockReady = stockPreview.reservationLedger?.writeReady === true
    && stockPreview.inventoryConsumptionReady === true
    && blockingStockErrors.length === 0;
  const canEnd = status === 'ACTIVE';
  const canReopen = status === 'ENDED' && format === 'BUY_NOW' && desiredStock > 0 && commerceStockReady;
  const blockers = [];
  if (status === 'ENDED' && format !== 'BUY_NOW') blockers.push('Завершену offer можна відновити цим flow тільки у форматі BUY_NOW.');
  if (status === 'ENDED' && desiredStock <= 0) blockers.push('На окремому складі інтернет-магазину немає доступного stock для reopen.');
  if (status === 'ENDED' && !commerceStockReady) blockers.push('Commerce Inventory/reservation ledger ще не готові до безпечного reopen.');
  if (status === 'INACTIVE') blockers.push('INACTIVE draft активується через Stage 3D.3, а не lifecycle reopen.');
  if (status === 'ACTIVATING') blockers.push('Offer зараз ACTIVATING — дочекайтеся завершення активації.');

  return {
    stage: '3D.7A',
    readOnlyUpstream: true,
    providerWriteCalls: 0,
    productId,
    accountId,
    listingId: String(listing._id),
    offerId: text(offer.id, 200),
    publicationStatus: status,
    endedBy: text(offer?.publication?.endedBy, 80).toUpperCase(),
    sellingModeFormat: format,
    desiredStock,
    actualStock,
    requiresStockPreparation: status === 'ENDED' && desiredStock > 0 && actualStock !== desiredStock,
    canEnd,
    canReopen,
    commerceStockReady,
    blockers,
    lifecycle: lifecycleData(listing),
  };
}

async function persistLifecycle(listing, patch = {}, listingStatus = '') {
  const pd = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = pd.allegro && typeof pd.allegro === 'object' ? pd.allegro : {};
  pd.allegro = {
    ...allegro,
    lifecycle: {
      ...(allegro.lifecycle && typeof allegro.lifecycle === 'object' ? allegro.lifecycle : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = pd;
  listing.markModified('providerData');
  if (listingStatus) listing.status = listingStatus;
  await listing.save();
}

function actionName(action) { return action === 'end' ? ACTION_END : ACTION_REOPEN; }
function targetStatus(action) { return action === 'end' ? 'ENDED' : 'ACTIVE'; }

async function ensureJob(listing, action) {
  const gen = generation(listing);
  const key = `allegro:${actionName(action)}:${String(listing._id)}:${gen}`;
  let job = await CommercePublicationJob.findOne({ idempotencyKey: key });
  if (job) return job;
  try {
    return await CommercePublicationJob.create({
      idempotencyKey: key,
      provider: PROVIDER,
      action: actionName(action),
      commerceProductId: listing.commerceProductId,
      channelListingId: listing._id,
      accountId: listing.accountId,
      externalKey: text(listing.externalId, 200),
      providerEntityId: text(listing.externalId, 200),
      state: 'reserved',
      resultSnapshot: { lifecycleGeneration: gen, lifecycleAction: action, phase: 'reserved' },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey: key });
  }
}

function snapshot(job) { return job?.resultSnapshot && typeof job.resultSnapshot === 'object' ? job.resultSnapshot : {}; }
async function patchJob(job, patch) {
  job.resultSnapshot = { ...snapshot(job), ...patch };
  job.markModified('resultSnapshot');
  await job.save();
}

function publicJob(job, listing, extra = {}) {
  const snap = snapshot(job);
  return {
    stage: '3D.7A',
    productId: String(job.commerceProductId || listing.commerceProductId || ''),
    accountId: text(job.accountId || listing.accountId, 80),
    listingId: String(job.channelListingId || listing._id || ''),
    offerId: text(job.providerEntityId || listing.externalId, 200),
    jobId: text(job.jobId, 80),
    action: text(snap.lifecycleAction, 20),
    phase: text(snap.phase, 40),
    state: text(job.state, 40),
    desiredStock: snap.desiredStock == null ? null : whole(snap.desiredStock),
    quantityCommandId: text(snap.quantityCommandId, 100),
    publicationCommandId: text(snap.publicationCommandId, 100),
    attempts: Number(job.attempts || 0),
    canRetry: snap.canRetry === true,
    lastErrorCode: text(job.lastErrorCode, 160),
    lastError: text(job.lastError, 1500),
    ...extra,
  };
}

function offerCriteria(offerId) {
  return [{ type: 'CONTAINS_OFFERS', offers: [{ id: text(offerId, 200) }] }];
}

async function pollCommand(accountId, type, commandId, offerId) {
  const base = type === 'quantity' ? '/sale/offer-quantity-change-commands' : '/sale/offer-publication-commands';
  let summary;
  try {
    summary = await allegroRequest(accountId, { method: 'GET', path: `${base}/${encodeURIComponent(commandId)}`, retryPolicy: 'safe', maxAttempts: 3, stage: `commerce_lifecycle_${type}_summary` });
  } catch (error) {
    if (upstreamStatus(error) === 404) return { state: 'missing' };
    throw error;
  }
  const tasks = await allegroRequest(accountId, { method: 'GET', path: `${base}/${encodeURIComponent(commandId)}/tasks`, query: { limit: 1000 }, retryPolicy: 'safe', maxAttempts: 3, stage: `commerce_lifecycle_${type}_tasks` });
  const all = Array.isArray(tasks.payload?.tasks) ? tasks.payload.tasks : [];
  const task = all.find((row) => text(row?.offer?.id, 200) === text(offerId, 200)) || all[0] || null;
  const status = text(task?.status, 40).toUpperCase();
  if (status === 'SUCCESS') return { state: 'success', task, summary: summary.payload };
  if (status === 'FAIL') return { state: 'failed', task, summary: summary.payload };
  const counts = summary.payload?.taskCount || {};
  const total = Number(counts.total || 0), failed = Number(counts.failed || 0), success = Number(counts.success || 0);
  if (total > 0 && failed + success >= total) return { state: failed > 0 ? 'failed' : 'success', task, summary: summary.payload };
  return { state: 'pending', task, summary: summary.payload };
}

async function submitQuantity(listing, job, desiredStock, commandId = '') {
  const id = commandId || crypto.randomUUID();
  job.state = 'sending'; job.attempts = Number(job.attempts || 0) + 1; job.lastAttemptAt = new Date();
  await patchJob(job, { phase: 'stock_sending', desiredStock, quantityCommandId: id, canRetry: false });
  try {
    await allegroRequest(listing.accountId, {
      method: 'PUT', path: `/sale/offer-quantity-change-commands/${encodeURIComponent(id)}`,
      body: { modification: { changeType: 'FIXED', value: whole(desiredStock) }, offerCriteria: offerCriteria(listing.externalId) },
      retryPolicy: 'idempotent', maxAttempts: 3, stage: 'commerce_lifecycle_reopen_stock_prepare', accept: PUBLIC_MIME, contentType: PUBLIC_MIME,
    });
    job.state = 'pending'; job.providerOperationId = id; job.providerOperationPath = `/sale/offer-quantity-change-commands/${id}`; job.lastError = ''; job.lastErrorCode = '';
    await patchJob(job, { phase: 'stock_pending', canRetry: false });
    await persistLifecycle(listing, { state: 'pending', action: 'reopen', phase: 'stock_pending', jobId: job.jobId, desiredStock, quantityCommandId: id, publicationStatus: 'ENDED', lastError: '', lastErrorCode: '' });
    return publicJob(job, listing, { pending: true });
  } catch (error) {
    if (upstreamStatus(error) === 409) {
      job.state = 'pending'; await patchJob(job, { phase: 'stock_pending', canRetry: false });
      await persistLifecycle(listing, { state: 'pending', action: 'reopen', phase: 'stock_pending', jobId: job.jobId, desiredStock, quantityCommandId: id, publicationStatus: 'ENDED' });
      return publicJob(job, listing, { pending: true, recovered409: true });
    }
    job.state = ambiguous(error) ? 'unknown' : 'failed';
    job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_lifecycle_stock_prepare_failed';
    job.lastError = text(error?.message, 1500); job.completedAt = job.state === 'failed' ? new Date() : null;
    await patchJob(job, { phase: 'stock_unknown', canRetry: job.state === 'unknown' });
    await persistLifecycle(listing, { state: job.state, action: 'reopen', phase: 'stock_unknown', jobId: job.jobId, desiredStock, quantityCommandId: id, publicationStatus: 'ENDED', lastError: job.lastError, lastErrorCode: job.lastErrorCode });
    if (job.state === 'failed') throw error;
    return publicJob(job, listing, { ambiguous: true });
  }
}

async function submitPublication(listing, job, action, commandId = '') {
  const id = commandId || crypto.randomUUID();
  const publicationAction = action === 'end' ? 'END' : 'ACTIVATE';
  job.state = 'sending'; job.attempts = Number(job.attempts || 0) + 1; job.lastAttemptAt = new Date();
  await patchJob(job, { phase: 'publication_sending', publicationCommandId: id, canRetry: false });
  try {
    await allegroRequest(listing.accountId, {
      method: 'PUT', path: `/sale/offer-publication-commands/${encodeURIComponent(id)}`,
      body: { publication: { action: publicationAction }, offerCriteria: offerCriteria(listing.externalId) },
      retryPolicy: 'idempotent', maxAttempts: 3, stage: `commerce_lifecycle_${action}`, accept: PUBLIC_MIME, contentType: PUBLIC_MIME,
    });
    job.state = 'pending'; job.providerOperationId = id; job.providerOperationPath = `/sale/offer-publication-commands/${id}`; job.lastError = ''; job.lastErrorCode = '';
    await patchJob(job, { phase: 'publication_pending', canRetry: false });
    await persistLifecycle(listing, { state: 'pending', action, phase: 'publication_pending', jobId: job.jobId, desiredStock: snapshot(job).desiredStock ?? null, publicationCommandId: id, publicationStatus: action === 'end' ? 'ACTIVE' : 'ENDED', lastError: '', lastErrorCode: '' });
    return publicJob(job, listing, { pending: true });
  } catch (error) {
    if (upstreamStatus(error) === 409) {
      job.state = 'pending'; await patchJob(job, { phase: 'publication_pending', canRetry: false });
      await persistLifecycle(listing, { state: 'pending', action, phase: 'publication_pending', jobId: job.jobId, desiredStock: snapshot(job).desiredStock ?? null, publicationCommandId: id, publicationStatus: action === 'end' ? 'ACTIVE' : 'ENDED' });
      return publicJob(job, listing, { pending: true, recovered409: true });
    }
    job.state = ambiguous(error) ? 'unknown' : 'failed';
    job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_lifecycle_publication_failed';
    job.lastError = text(error?.message, 1500); job.completedAt = job.state === 'failed' ? new Date() : null;
    await patchJob(job, { phase: 'publication_unknown', canRetry: job.state === 'unknown' });
    await persistLifecycle(listing, { state: job.state, action, phase: 'publication_unknown', jobId: job.jobId, desiredStock: snapshot(job).desiredStock ?? null, publicationCommandId: id, lastError: job.lastError, lastErrorCode: job.lastErrorCode });
    if (job.state === 'failed') throw error;
    return publicJob(job, listing, { ambiguous: true });
  }
}

async function confirmLifecycle(listing, job, action, offer) {
  const expected = targetStatus(action);
  const status = publicationStatus(offer);
  if (status !== expected) return publicJob(job, listing, { pending: true, publicationStatus: status, message: `Allegro command завершився, але offer ще має статус ${status || 'UNKNOWN'}.` });
  const snap = snapshot(job); const nextGen = Math.max(generation(listing), Number(snap.lifecycleGeneration || 0) + 1); const now = new Date();
  job.state = 'confirmed'; job.providerStatus = status; job.completedAt = now; job.lastError = ''; job.lastErrorCode = '';
  await patchJob(job, { phase: 'confirmed', canRetry: false, confirmedAt: now });
  await persistLifecycle(listing, {
    generation: nextGen,
    state: 'confirmed',
    action,
    phase: 'confirmed',
    jobId: job.jobId,
    publicationStatus: status,
    desiredStock: snap.desiredStock == null ? null : whole(snap.desiredStock),
    quantityCommandId: text(snap.quantityCommandId, 100),
    publicationCommandId: text(snap.publicationCommandId, 100),
    verifiedAt: now,
    lastError: '',
    lastErrorCode: '',
  }, status === 'ACTIVE' ? 'active' : 'ended');
  return publicJob(job, listing, { confirmed: true, publicationStatus: status });
}

async function failTask(listing, job, result, phase) {
  const task = result?.task || {};
  job.state = 'failed'; job.completedAt = new Date(); job.lastErrorCode = 'commerce_allegro_lifecycle_command_failed';
  job.lastError = text(task?.message || task?.errors?.[0]?.userMessage || task?.errors?.[0]?.message || 'Allegro lifecycle command failed.', 1500);
  await patchJob(job, { phase: `${phase}_failed`, canRetry: true });
  await persistLifecycle(listing, { state: 'failed', action: snapshot(job).lifecycleAction, phase: `${phase}_failed`, jobId: job.jobId, lastError: job.lastError, lastErrorCode: job.lastErrorCode });
  return publicJob(job, listing, { canRetry: true });
}

async function resumeJob(listing, job, retryUnknown, currentPreview = null) {
  const snap = snapshot(job); const action = text(snap.lifecycleAction, 20); const phase = text(snap.phase, 40);
  if (job.state === 'confirmed') {
    const { offer } = await readOffer(listing, 'commerce_lifecycle_confirmed_readback');
    return confirmLifecycle(listing, job, action, offer);
  }

  if (phase.startsWith('stock_')) {
    const commandId = text(snap.quantityCommandId, 100);
    const polled = commandId ? await pollCommand(listing.accountId, 'quantity', commandId, listing.externalId) : { state: 'missing' };
    if (polled.state === 'failed') return failTask(listing, job, polled, 'stock');
    if (polled.state === 'pending') { job.state = 'pending'; await patchJob(job, { phase: 'stock_pending', canRetry: false }); return publicJob(job, listing, { pending: true }); }
    if (polled.state === 'missing') {
      job.state = 'unknown'; await patchJob(job, { phase: 'stock_unknown', canRetry: true });
      if (!retryUnknown) return publicJob(job, listing, { ambiguous: true, canRetry: true });
      if (!currentPreview || currentPreview.canReopen !== true || whole(currentPreview.desiredStock) !== whole(snap.desiredStock)) {
        job.state = 'failed'; job.lastErrorCode = 'commerce_allegro_lifecycle_reopen_stale_stock'; job.lastError = 'Commerce desired stock змінився після невідомого quantity command. Старий commandId не повторюємо.'; job.completedAt = new Date();
        await patchJob(job, { phase: 'stock_stale', canRetry: true });
        await persistLifecycle(listing, { state: 'failed', action: 'reopen', phase: 'stock_stale', jobId: job.jobId, desiredStock: snap.desiredStock, lastError: job.lastError, lastErrorCode: job.lastErrorCode });
        return publicJob(job, listing, { canRetry: true, staleDesired: true });
      }
      return submitQuantity(listing, job, whole(snap.desiredStock), commandId);
    }
    const { offer } = await readOffer(listing, 'commerce_lifecycle_stock_readback');
    if (publicationStatus(offer) !== 'ENDED' || offerStock(offer) !== whole(snap.desiredStock)) {
      job.state = 'unknown'; job.lastError = 'Quantity command завершився, але ENDED offer не має очікуваного stock.'; job.lastErrorCode = 'commerce_allegro_lifecycle_stock_readback_mismatch';
      await patchJob(job, { phase: 'stock_unknown', canRetry: false });
      return publicJob(job, listing, { ambiguous: true });
    }
    const fresh = await lifecyclePreview({ productId: String(listing.commerceProductId), accountId: listing.accountId });
    if (fresh.canReopen !== true || whole(fresh.desiredStock) !== whole(snap.desiredStock)) {
      job.state = 'failed'; job.completedAt = new Date(); job.lastErrorCode = 'commerce_allegro_lifecycle_reopen_stale_stock'; job.lastError = `Commerce desired stock змінився після quantity command (${whole(snap.desiredStock)} → ${whole(fresh.desiredStock)}). ACTIVATE не відправлено.`;
      await patchJob(job, { phase: 'stock_stale', canRetry: true });
      await persistLifecycle(listing, { state: 'failed', action: 'reopen', phase: 'stock_stale', jobId: job.jobId, desiredStock: snap.desiredStock, lastError: job.lastError, lastErrorCode: job.lastErrorCode });
      return publicJob(job, listing, { canRetry: true, staleDesired: true, currentDesiredStock: fresh.desiredStock });
    }
    job.state = 'reserved'; await patchJob(job, { phase: 'publication_reserved', canRetry: false });
    return submitPublication(listing, job, 'reopen');
  }

  if (phase.startsWith('publication_')) {
    const commandId = text(snap.publicationCommandId, 100);
    const polled = commandId ? await pollCommand(listing.accountId, 'publication', commandId, listing.externalId) : { state: 'missing' };
    if (polled.state === 'failed') return failTask(listing, job, polled, 'publication');
    if (polled.state === 'pending') { job.state = 'pending'; await patchJob(job, { phase: 'publication_pending', canRetry: false }); return publicJob(job, listing, { pending: true }); }
    if (polled.state === 'missing') {
      job.state = 'unknown'; await patchJob(job, { phase: 'publication_unknown', canRetry: true });
      if (!retryUnknown) return publicJob(job, listing, { ambiguous: true, canRetry: true });
      return submitPublication(listing, job, action, commandId);
    }
    const { offer } = await readOffer(listing, 'commerce_lifecycle_publication_readback');
    return confirmLifecycle(listing, job, action, offer);
  }
  return null;
}

async function manageAllegroLifecycle(raw = {}) {
  const productId = text(raw.productId, 80), accountId = text(raw.accountId, 80), action = text(raw.action, 20).toLowerCase();
  if (!['end', 'reopen'].includes(action)) throw appError('commerce_allegro_lifecycle_action_required');
  if (!mongoose.isValidObjectId(productId)) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');
  await requireAccount(accountId, true);
  const listing = await requireListing(productId, accountId);
  const preview = await lifecyclePreview({ productId, accountId });
  const unresolved = await CommercePublicationJob.findOne({
    provider: PROVIDER,
    channelListingId: listing._id,
    action: actionName(action),
    state: { $in: ['sending', 'pending', 'unknown'] },
  }).sort({ updatedAt: -1 });
  if (unresolved) {
    if (preview.publicationStatus === targetStatus(action)) {
      const { offer } = await readOffer(listing, 'commerce_lifecycle_unresolved_readback');
      return confirmLifecycle(listing, unresolved, action, offer);
    }
    const resumed = await resumeJob(listing, unresolved, raw.retryUnknown === true, preview);
    if (resumed) return resumed;
  }
  if ((action === 'end' && preview.publicationStatus === 'ENDED') || (action === 'reopen' && preview.publicationStatus === 'ACTIVE')) {
    await persistLifecycle(listing, { state: 'confirmed', action, phase: 'already_applied', publicationStatus: preview.publicationStatus, verifiedAt: new Date() }, preview.publicationStatus === 'ACTIVE' ? 'active' : 'ended');
    return { stage: '3D.7A', action, state: 'confirmed', alreadyApplied: true, ...preview };
  }
  if (action === 'end' && !preview.canEnd) throw appError('commerce_allegro_lifecycle_transition_invalid', { action, publicationStatus: preview.publicationStatus });
  if (action === 'reopen' && !preview.canReopen) throw appError('commerce_allegro_lifecycle_reopen_not_ready', { blockers: preview.blockers });

  let job = await ensureJob(listing, action);
  if (['pending', 'unknown', 'sending'].includes(job.state) || text(snapshot(job).phase, 40).includes('pending') || text(snapshot(job).phase, 40).includes('unknown')) {
    const resumed = await resumeJob(listing, job, raw.retryUnknown === true, preview);
    if (resumed) return resumed;
  }
  if (job.state === 'failed' && raw.retryFailed !== true) return publicJob(job, listing, { canRetry: true });
  if (job.state === 'failed') {
    job.state = 'reserved'; job.completedAt = null; job.lastError = ''; job.lastErrorCode = '';
    await patchJob(job, { phase: 'reserved', canRetry: false, quantityCommandId: '', publicationCommandId: '' });
  }

  if (action === 'reopen') {
    job.requestHash = requestHash({ action, desiredStock: preview.desiredStock, offerId: listing.externalId });
    await patchJob(job, { lifecycleAction: action, desiredStock: preview.desiredStock });
    if (preview.actualStock !== preview.desiredStock) return submitQuantity(listing, job, preview.desiredStock);
  } else {
    job.requestHash = requestHash({ action, offerId: listing.externalId });
  }
  await patchJob(job, { lifecycleAction: action, desiredStock: action === 'reopen' ? preview.desiredStock : null });
  return submitPublication(listing, job, action);
}

module.exports = {
  ACTION_END,
  ACTION_REOPEN,
  lifecyclePreview,
  manageAllegroLifecycle,
};
