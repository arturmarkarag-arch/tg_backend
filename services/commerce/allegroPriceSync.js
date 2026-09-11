'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getCatalogProductsByIds } = require('./catalog');
const { effectivePrice } = require('./publicationPreview');
const { stableExternalKey, requestHash } = require('./allegroDraftOffer');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const ACTION = 'sync_price';
const MARKETPLACE_ID = 'allegro-pl';
const BULK_MIME = 'application/vnd.allegro.beta.v1+json';
const PUBLIC_MIME = 'application/vnd.allegro.public.v1+json';
const MAX_ITEMS = 250;
const BULK_LIMIT = 25;
const OFFER_LOOKUP_CHUNK = 50;
const POST_RATE_POLICY = { key: 'sale-offer-bulk-modification-commands', limit: 100, windowMs: 60_000 };

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function moneyAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return (Math.round(number * 100) / 100).toFixed(2);
}

function normalizeItems(raw = {}) {
  const source = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  const out = [];
  for (const row of source) {
    const productId = text(row?.productId, 80);
    const accountId = text(row?.accountId, 80);
    if (!mongoose.isValidObjectId(productId) || !accountId) continue;
    const key = `${productId}:${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ productId, accountId, key });
    if (out.length >= MAX_ITEMS) break;
  }
  if (!out.length) throw appError('commerce_allegro_price_sync_items_required');
  return out;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function savedAllegro(listing) {
  const providerData = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  return providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
}

function savedPriceSync(listing) {
  const allegro = savedAllegro(listing);
  return allegro.priceSync && typeof allegro.priceSync === 'object' ? allegro.priceSync : {};
}

async function persistPriceSync(listing, patch = {}) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...allegro,
    priceSync: {
      ...(allegro.priceSync && typeof allegro.priceSync === 'object' ? allegro.priceSync : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

function normalizePrice(raw = {}) {
  return {
    amount: moneyAmount(raw?.amount),
    currency: text(raw?.currency, 10).toUpperCase(),
  };
}

function samePrice(left = {}, right = {}) {
  const a = normalizePrice(left);
  const b = normalizePrice(right);
  return Boolean(a.amount && b.amount) && a.amount === b.amount && a.currency === b.currency;
}

function priceAutomationRule(offer = {}) {
  const rule = offer?.sellingMode?.priceAutomation?.rule;
  if (!rule || typeof rule !== 'object' || !text(rule.id, 200)) return null;
  return { id: text(rule.id, 200), type: text(rule.type, 100) };
}

async function requirePriceAccount(accountId, { write = false } = {}) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true || (write && matrix.capabilities.saleOffersWrite !== true)) {
    throw appError(write ? 'commerce_allegro_price_sync_scope_required' : 'commerce_allegro_price_preview_scope_required');
  }
  return account;
}

async function fetchOffersByExternalKeys(accountId, externalKeys) {
  const offerByExternal = new Map();
  let providerCalls = 0;
  for (const part of chunks([...new Set(externalKeys.filter(Boolean))], OFFER_LOOKUP_CHUNK)) {
    if (!part.length) continue;
    const result = await allegroRequest(accountId, {
      method: 'GET',
      path: '/sale/offers',
      query: {
        'external.id': part,
        'publication.status': ['ACTIVE', 'INACTIVE', 'ACTIVATING', 'ENDED'],
        limit: Math.min(1000, Math.max(1, part.length)),
      },
      retryPolicy: 'safe',
      maxAttempts: 3,
      stage: 'commerce_price_sync_offer_lookup',
      accept: PUBLIC_MIME,
    });
    providerCalls += 1;
    for (const offer of (Array.isArray(result.payload?.offers) ? result.payload.offers : [])) {
      const externalKey = text(offer?.external?.id, 100);
      if (externalKey) offerByExternal.set(externalKey, offer);
    }
  }
  return { offerByExternal, providerCalls };
}

async function loadLocalRows(items) {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const [products, listings] = await Promise.all([
    getCatalogProductsByIds(productIds),
    ChannelListing.find({
      provider: PROVIDER,
      $or: items.map((item) => ({ commerceProductId: item.productId, accountId: item.accountId })),
    }).lean(),
  ]);
  const productById = new Map(products.map((row) => [String(row.id), row]));
  const listingByKey = new Map(listings.map((row) => [`${String(row.commerceProductId)}:${row.accountId}`, row]));
  return items.map((item) => ({
    ...item,
    product: productById.get(item.productId) || null,
    listing: listingByKey.get(item.key) || null,
  }));
}

function localRowValidation(row) {
  const errors = [];
  const listing = row.listing;
  const product = row.product;
  if (!product) errors.push({ code: 'product_not_found', message: 'Commerce Product не знайдено.' });
  if (!listing) errors.push({ code: 'listing_not_found', message: 'Для товару немає Allegro ChannelListing.' });
  if (listing && !text(listing.externalId, 200)) errors.push({ code: 'offer_not_bound', message: 'ChannelListing не має Allegro offerId.' });
  const active = listing && (text(listing.status, 40) === 'active' || text(listing?.providerData?.allegro?.activation?.state, 40) === 'confirmed');
  if (listing && !active) errors.push({ code: 'offer_not_active_locally', message: 'Price Sync запускаємо тільки для offer, який уже пройшов 3D.3 Activation.' });

  const desiredRaw = product && listing ? effectivePrice(product, listing) : { value: 0, currency: 'PLN' };
  const desiredPrice = { amount: moneyAmount(desiredRaw.value), currency: text(desiredRaw.currency || 'PLN', 10).toUpperCase() };
  if (!desiredPrice.amount) errors.push({ code: 'price_invalid', message: 'Desired price має бути більшою за 0.' });
  if (desiredPrice.currency !== 'PLN') errors.push({ code: 'currency_not_supported', message: 'Stage 3D.5 зараз синхронізує базовий marketplace allegro-pl у PLN.' });

  const externalKey = listing ? text(listing?.providerData?.allegro?.draftCreation?.externalKey, 100) || stableExternalKey(listing._id) : '';
  return { errors, desiredPrice, externalKey, active };
}

async function previewAllegroPriceSync(raw = {}) {
  const items = normalizeItems(raw);
  const localRows = await loadLocalRows(items);
  const grouped = new Map();
  for (const row of localRows) {
    if (!grouped.has(row.accountId)) grouped.set(row.accountId, []);
    grouped.get(row.accountId).push(row);
  }

  const rows = [];
  let providerCalls = 0;
  for (const [accountId, accountRows] of grouped.entries()) {
    let accountError = null;
    try { await requirePriceAccount(accountId, { write: false }); } catch (error) { accountError = error; }
    const prepared = accountRows.map((row) => ({ row, local: localRowValidation(row) }));
    let offerByExternal = new Map();
    if (!accountError) {
      const lookup = await fetchOffersByExternalKeys(accountId, prepared.map((item) => item.local.externalKey));
      offerByExternal = lookup.offerByExternal;
      providerCalls += lookup.providerCalls;
    }

    for (const item of prepared) {
      const { row, local } = item;
      const errors = [...local.errors];
      if (accountError) errors.push({ code: text(accountError.code, 160) || 'account_unavailable', message: 'Allegro-акаунт не готовий до читання offers. Перевірте OAuth/scopes.' });
      const offer = local.externalKey ? offerByExternal.get(local.externalKey) : null;
      if (!accountError && !offer) errors.push({ code: 'offer_not_found_upstream', message: 'Не знайшли offer в Allegro за нашим external.id.' });

      const publicationStatus = text(offer?.publication?.status, 40).toUpperCase();
      if (offer && publicationStatus !== 'ACTIVE') errors.push({ code: 'offer_not_active_upstream', message: `Offer в Allegro має статус ${publicationStatus || 'UNKNOWN'}, а Price Sync очікує ACTIVE.` });
      const actualPrice = normalizePrice(offer?.sellingMode?.price || {});
      const automationRule = priceAutomationRule(offer);
      const inSync = Boolean(offer) && samePrice(local.desiredPrice, actualPrice);
      const needsChange = errors.length === 0 && !inSync;
      const requiresAutomationOverride = needsChange && Boolean(automationRule?.id);
      const desiredHash = requestHash({ marketplaceId: MARKETPLACE_ID, price: local.desiredPrice });
      const actualHash = requestHash({ price: actualPrice, automationRule, publicationStatus });
      const saved = row.listing ? savedPriceSync(row.listing) : {};

      rows.push({
        productId: row.productId,
        productName: text(row.product?.name, 300),
        accountId,
        listingId: row.listing ? String(row.listing._id) : '',
        offerId: text(row.listing?.externalId, 200),
        externalKey: local.externalKey,
        publicationStatus,
        desiredPrice: local.desiredPrice,
        actualPrice,
        desiredHash,
        actualHash,
        inSync,
        needsChange,
        requiresAutomationOverride,
        automationRule,
        errors,
        savedState: text(saved.state, 40),
        savedCommandId: text(saved.commandId, 100),
        savedLastError: text(saved.lastError, 1500),
      });
    }
  }

  return {
    stage: '3D.5',
    upstreamMode: 'offer-bulk-modification-commands',
    betaResource: true,
    marketplaceId: MARKETPLACE_ID,
    maxModificationsPerCommand: BULK_LIMIT,
    providerCalls,
    summary: {
      total: rows.length,
      inSync: rows.filter((row) => row.inSync && !row.errors.length).length,
      changes: rows.filter((row) => row.needsChange).length,
      blocked: rows.filter((row) => row.errors.length > 0).length,
      automationOverrides: rows.filter((row) => row.requiresAutomationOverride).length,
    },
    rows,
  };
}

function jobActualHash(row) {
  return text(row.actualHash, 128) || requestHash({ price: row.actualPrice, automationRule: row.automationRule, publicationStatus: row.publicationStatus });
}

function jobKey(listingId, row) {
  return `allegro:${ACTION}:${text(listingId, 80)}:${text(row.desiredHash, 128)}:${jobActualHash(row)}`;
}

async function ensureJob(listing, row) {
  const idempotencyKey = jobKey(listing._id, row);
  let job = await CommercePublicationJob.findOne({ idempotencyKey });
  if (job) return job;
  try {
    return await CommercePublicationJob.create({
      idempotencyKey,
      provider: PROVIDER,
      action: ACTION,
      commerceProductId: listing.commerceProductId,
      channelListingId: listing._id,
      accountId: listing.accountId,
      externalKey: text(row.externalKey, 100),
      requestHash: text(row.desiredHash, 128),
      state: 'reserved',
      providerEntityId: text(listing.externalId, 200),
      resultSnapshot: {
        marketplaceId: MARKETPLACE_ID,
        desiredPrice: row.desiredPrice,
        observedPrice: row.actualPrice,
        observedActualHash: jobActualHash(row),
        automationRule: row.automationRule || null,
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey });
  }
}

function desiredFromJob(job) {
  const desired = job?.resultSnapshot?.desiredPrice || {};
  return normalizePrice(desired);
}

function commandPath(commandId) {
  return `/sale/offer-bulk-modification-commands/${encodeURIComponent(commandId)}`;
}

function taskMessage(task) {
  const first = Array.isArray(task?.errors) ? task.errors[0] : null;
  return text(first?.userMessage || first?.message || task?.message || 'Allegro відхилив зміну ціни.', 1500);
}

async function setJobsCommand(jobs, commandId) {
  const now = new Date();
  for (const job of jobs) {
    job.state = 'sending';
    job.providerOperationId = commandId;
    job.providerOperationPath = commandPath(commandId);
    job.providerStatus = 'SENDING';
    job.attempts = Number(job.attempts || 0) + 1;
    job.lastAttemptAt = now;
    job.lastError = '';
    job.lastErrorCode = '';
    job.resultSnapshot = { ...(job.resultSnapshot || {}), commandId };
    await job.save();
  }
}

async function setListingsState(jobs, patchFactory) {
  const listingDocs = await ChannelListing.find({ _id: { $in: jobs.map((job) => job.channelListingId) } });
  const listingById = new Map(listingDocs.map((row) => [String(row._id), row]));
  for (const job of jobs) {
    const listing = listingById.get(String(job.channelListingId));
    if (!listing) continue;
    await persistPriceSync(listing, patchFactory(job));
  }
}

function modificationForJob(job) {
  const price = desiredFromJob(job);
  return {
    offerId: text(job.providerEntityId, 200),
    prices: {
      [MARKETPLACE_ID]: {
        changeType: 'FIXED',
        value: price,
      },
    },
  };
}

function isAmbiguous(error) {
  const code = text(error?.code, 160);
  if (['allegro_upstream_timeout', 'allegro_upstream_unavailable'].includes(code)) return true;
  const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
  return status === 408 || status === 425 || status >= 500;
}

async function submitCommand(accountId, jobs, commandId) {
  await setJobsCommand(jobs, commandId);
  await setListingsState(jobs, (job) => ({
    state: 'sending',
    desiredHash: text(job.requestHash, 128),
    desiredPrice: desiredFromJob(job),
    commandId,
    jobId: job.jobId,
    canRetry: false,
    lastError: '',
    lastErrorCode: '',
  }));

  try {
    const result = await allegroRequest(accountId, {
      method: 'POST',
      path: '/sale/offer-bulk-modification-commands',
      body: {
        commandId,
        modifications: jobs.map(modificationForJob),
      },
      retryPolicy: 'never',
      maxAttempts: 1,
      stage: 'commerce_price_sync_command',
      accept: BULK_MIME,
      contentType: BULK_MIME,
      ratePolicy: POST_RATE_POLICY,
    });
    for (const job of jobs) {
      job.state = 'pending';
      job.providerStatus = 'PENDING';
      job.providerTraceId = result.traceId || '';
      job.providerRequestId = result.requestId || '';
      job.lastHttpStatus = result.status;
      await job.save();
    }
    await setListingsState(jobs, (job) => ({
      state: 'pending', commandId, jobId: job.jobId, desiredHash: job.requestHash,
      desiredPrice: desiredFromJob(job), canRetry: false, lastError: '', lastErrorCode: '',
    }));
    return { state: 'pending', commandId };
  } catch (error) {
    const upstreamStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
    if (upstreamStatus === 409) {
      // The client-generated commandId is unique. 409 means Allegro already knows
      // this command, so we recover by polling instead of creating a new command.
      for (const job of jobs) {
        job.state = 'pending';
        job.providerStatus = 'PENDING';
        job.lastHttpStatus = 409;
        await job.save();
      }
      await setListingsState(jobs, (job) => ({ state: 'pending', commandId, jobId: job.jobId, canRetry: false }));
      return { state: 'pending', commandId, recovered409: true };
    }
    if (isAmbiguous(error)) {
      for (const job of jobs) {
        job.state = 'unknown';
        job.providerStatus = 'UNKNOWN';
        job.lastHttpStatus = upstreamStatus;
        job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_price_sync_unknown';
        job.lastError = 'Результат bulk price command невідомий. Новий commandId автоматично не створюємо; спочатку перевіряємо цей commandId.';
        await job.save();
      }
      await setListingsState(jobs, (job) => ({
        state: 'unknown', commandId, jobId: job.jobId, canRetry: false,
        lastErrorCode: job.lastErrorCode, lastError: job.lastError,
      }));
      return { state: 'unknown', commandId };
    }
    for (const job of jobs) {
      job.state = 'failed';
      job.providerStatus = 'FAILED';
      job.completedAt = new Date();
      job.lastHttpStatus = upstreamStatus;
      job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_price_sync_failed';
      job.lastError = text(error?.message, 1500);
      await job.save();
    }
    await setListingsState(jobs, (job) => ({
      state: 'failed', commandId, jobId: job.jobId, canRetry: true,
      lastErrorCode: job.lastErrorCode, lastError: job.lastError,
    }));
    return { state: 'failed', commandId };
  }
}

async function markTaskFailed(job, task) {
  job.state = 'failed';
  job.providerStatus = 'FAIL';
  job.completedAt = new Date();
  job.lastErrorCode = text(task?.errors?.[0]?.code, 160) || 'commerce_allegro_price_sync_task_failed';
  job.lastError = taskMessage(task);
  job.resultSnapshot = { ...(job.resultSnapshot || {}), task };
  await job.save();
  const listing = await ChannelListing.findById(job.channelListingId);
  if (listing) await persistPriceSync(listing, {
    state: 'failed', desiredHash: job.requestHash, desiredPrice: desiredFromJob(job), commandId: job.providerOperationId,
    jobId: job.jobId, canRetry: true, lastErrorCode: job.lastErrorCode, lastError: job.lastError,
  });
}

async function verifySuccessfulJobs(jobs) {
  if (!jobs.length) return;
  const items = jobs.map((job) => ({ productId: String(job.commerceProductId), accountId: job.accountId }));
  const preview = await previewAllegroPriceSync({ items });
  const previewByKey = new Map(preview.rows.map((row) => [`${row.productId}:${row.accountId}`, row]));
  for (const job of jobs) {
    const row = previewByKey.get(`${String(job.commerceProductId)}:${job.accountId}`);
    const listing = await ChannelListing.findById(job.channelListingId);
    if (!listing) continue;
    const storedDesired = desiredFromJob(job);
    const storedAppliedHash = text(job.requestHash, 128);
    const actualMatchesStored = row ? samePrice(storedDesired, row.actualPrice) : false;
    const currentDesiredHash = text(row?.desiredHash, 128);
    const stillCurrent = Boolean(currentDesiredHash) && currentDesiredHash === storedAppliedHash;

    job.state = 'confirmed';
    job.providerStatus = actualMatchesStored ? 'SUCCESS' : 'SUCCESS_BUT_DRIFT';
    job.completedAt = new Date();
    job.lastError = '';
    job.lastErrorCode = '';
    job.resultSnapshot = {
      ...(job.resultSnapshot || {}),
      verifiedAt: new Date(),
      actualPrice: row?.actualPrice || null,
      stillCurrent,
      actualMatchesStored,
    };
    await job.save();

    const inSync = actualMatchesStored && stillCurrent;
    await persistPriceSync(listing, {
      state: inSync ? 'confirmed' : 'out_of_sync',
      desiredHash: currentDesiredHash || storedAppliedHash,
      appliedHash: actualMatchesStored ? storedAppliedHash : '',
      desiredPrice: row?.desiredPrice || storedDesired,
      actualPrice: row?.actualPrice || null,
      automationRule: row?.automationRule || null,
      commandId: job.providerOperationId,
      jobId: job.jobId,
      verifiedAt: new Date(),
      appliedAt: actualMatchesStored ? new Date() : null,
      stillCurrent,
      canRetry: false,
      lastError: inSync ? '' : 'Bulk command завершився успішно, але поточна ціна або desired state уже відрізняються. Потрібен новий Price Sync.',
      lastErrorCode: inSync ? '' : 'commerce_allegro_price_sync_drift',
    });
  }
}

async function pollCommand(accountId, commandId, jobs) {
  let summary;
  try {
    summary = await allegroRequest(accountId, {
      method: 'GET',
      path: commandPath(commandId),
      retryPolicy: 'safe',
      maxAttempts: 3,
      stage: 'commerce_price_sync_command_summary',
      accept: BULK_MIME,
    });
  } catch (error) {
    const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
    if (status === 404) {
      for (const job of jobs) {
        if (job.state === 'unknown') {
          job.lastErrorCode = 'commerce_allegro_price_sync_command_not_found';
          job.lastError = 'Allegro ще не знаходить commandId. Можна явно повторити той самий commandId; інший commandId створювати не будемо.';
          await job.save();
        }
      }
      await setListingsState(jobs, (job) => ({
        state: job.state, commandId, jobId: job.jobId, canRetry: job.state === 'unknown',
        lastErrorCode: job.lastErrorCode, lastError: job.lastError,
      }));
      return { state: jobs.some((job) => job.state === 'unknown') ? 'unknown' : 'pending', commandId, notFound: true };
    }
    throw error;
  }

  const taskCount = summary.payload?.taskCount || {};
  const completed = Boolean(summary.payload?.completedAt) || (Number(taskCount.total || 0) > 0 && Number(taskCount.success || 0) + Number(taskCount.failed || 0) >= Number(taskCount.total || 0));
  if (!completed) {
    for (const job of jobs) {
      if (job.state !== 'confirmed' && job.state !== 'failed') {
        job.state = 'pending';
        job.providerStatus = 'PENDING';
        await job.save();
      }
    }
    await setListingsState(jobs, (job) => ({ state: job.state, commandId, jobId: job.jobId, canRetry: false }));
    return { state: 'pending', commandId, taskCount };
  }

  const detail = await allegroRequest(accountId, {
    method: 'GET',
    path: `${commandPath(commandId)}/tasks`,
    query: { limit: 1000, offset: 0 },
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_price_sync_command_tasks',
    accept: BULK_MIME,
  });
  const tasks = Array.isArray(detail.payload?.tasks) ? detail.payload.tasks : [];
  const taskByOffer = new Map(tasks
    .filter((task) => text(task?.subject?.field, 40) === 'prices')
    .map((task) => [text(task?.subject?.offerId, 200), task]));

  const successful = [];
  for (const job of jobs) {
    const task = taskByOffer.get(text(job.providerEntityId, 200));
    const status = text(task?.status, 40).toUpperCase();
    if (status === 'SUCCESS') successful.push(job);
    else if (status === 'FAIL') await markTaskFailed(job, task);
    else {
      job.state = 'pending';
      job.providerStatus = status || 'NEW';
      await job.save();
    }
  }
  await verifySuccessfulJobs(successful);
  const refreshed = await CommercePublicationJob.find({ _id: { $in: jobs.map((job) => job._id) } }).lean();
  return {
    state: refreshed.every((job) => ['confirmed', 'failed'].includes(job.state)) ? 'confirmed' : 'pending',
    commandId,
    taskCount,
  };
}

async function retryUnknownCommand(accountId, commandId, jobs) {
  // Reuse the exact same client-generated commandId. If Allegro had accepted it,
  // it will answer 409 and we immediately return to polling; no duplicate command.
  return submitCommand(accountId, jobs, commandId);
}

async function refreshUnresolvedJobs(jobs, { retryUnknown = false, currentDesiredHashByListing = new Map() } = {}) {
  const grouped = new Map();
  for (const job of jobs) {
    const commandId = text(job.providerOperationId, 100);
    if (!commandId) continue;
    const key = `${job.accountId}:${commandId}`;
    if (!grouped.has(key)) grouped.set(key, { accountId: job.accountId, commandId, jobs: [] });
    grouped.get(key).jobs.push(job);
  }
  const results = [];
  for (const group of grouped.values()) {
    const poll = await pollCommand(group.accountId, group.commandId, group.jobs);
    if (poll.notFound && retryUnknown && group.jobs.every((job) => job.state === 'unknown')) {
      const stale = group.jobs.filter((job) => {
        const currentHash = text(currentDesiredHashByListing.get(String(job.channelListingId)), 128);
        return !currentHash || currentHash !== text(job.requestHash, 128);
      });
      if (stale.length) {
        // One Allegro command is atomic as a request envelope: we can only replay
        // the exact whole commandId. If even one modification is stale, replaying
        // that command could restore an old price, so the entire command stays
        // fail-closed until its original result becomes observable.
        for (const job of group.jobs) {
          job.lastErrorCode = 'commerce_allegro_price_sync_unknown_stale_desired';
          job.lastError = 'Command має невідомий результат, але desired price хоча б одного offer уже змінилась. Старий commandId не повторюємо.';
          await job.save();
        }
        await setListingsState(group.jobs, (job) => ({
          state: 'unknown', commandId: group.commandId, jobId: job.jobId, canRetry: false,
          lastErrorCode: job.lastErrorCode, lastError: job.lastError,
        }));
        results.push({ state: 'unknown', commandId: group.commandId, staleDesired: true });
      } else {
        results.push(await retryUnknownCommand(group.accountId, group.commandId, group.jobs));
      }
    } else results.push(poll);
  }
  return results;
}

async function applyAllegroPriceSync(raw = {}) {
  const items = normalizeItems(raw);

  // Recovery always comes first. A command may already have changed Allegro even
  // when the next price preview is in-sync, so unresolved jobs must never depend
  // on `needsChange` to stay pollable.
  const firstPreview = await previewAllegroPriceSync({ items });
  const selectedListingIds = firstPreview.rows.map((row) => row.listingId).filter(Boolean);
  const desiredHashByListing = new Map(firstPreview.rows
    .filter((row) => row.listingId)
    .map((row) => [String(row.listingId), text(row.desiredHash, 128)]));

  const existingUnresolved = selectedListingIds.length
    ? await CommercePublicationJob.find({
      provider: PROVIDER,
      action: ACTION,
      channelListingId: { $in: selectedListingIds },
      state: { $in: ['sending', 'pending', 'unknown'] },
    })
    : [];
  const trackedJobIds = new Set(existingUnresolved.map((job) => String(job._id)));
  if (existingUnresolved.length) {
    await refreshUnresolvedJobs(existingUnresolved, {
      retryUnknown: raw.retryUnknown === true,
      currentDesiredHashByListing: desiredHashByListing,
    });
  }

  // Re-read both our desired state and Allegro after recovery. Only this fresh
  // snapshot may create a new command.
  const preview = await previewAllegroPriceSync({ items });
  const blocked = preview.rows.filter((row) => row.errors.length > 0);
  const rowByListingId = new Map(preview.rows
    .filter((row) => row.listingId)
    .map((row) => [String(row.listingId), row]));

  const stillUnresolved = selectedListingIds.length
    ? await CommercePublicationJob.find({
      provider: PROVIDER,
      action: ACTION,
      channelListingId: { $in: selectedListingIds },
      state: { $in: ['sending', 'pending', 'unknown'] },
    })
    : [];
  for (const job of stillUnresolved) trackedJobIds.add(String(job._id));
  const unresolvedListingIds = new Set(stillUnresolved.map((job) => String(job.channelListingId)));
  const changes = preview.rows.filter((row) => row.needsChange && row.errors.length === 0 && !unresolvedListingIds.has(String(row.listingId)));

  const listingIds = changes.map((row) => row.listingId).filter(Boolean);
  const listingDocs = await ChannelListing.find({ _id: { $in: listingIds } });
  const listingById = new Map(listingDocs.map((row) => [String(row._id), row]));
  const jobs = [];
  const writeCheckedAccounts = new Set();
  for (const row of changes) {
    const listing = listingById.get(String(row.listingId));
    if (!listing) continue;
    if (!writeCheckedAccounts.has(row.accountId)) {
      await requirePriceAccount(row.accountId, { write: true });
      writeCheckedAccounts.add(row.accountId);
    }
    const job = await ensureJob(listing, row);
    jobs.push(job);
    trackedJobIds.add(String(job._id));
  }

  const afterRefresh = jobs.length
    ? await CommercePublicationJob.find({ _id: { $in: jobs.map((job) => job._id) } })
    : [];
  const byAccount = new Map();
  const jobsToSubmit = [];
  for (const job of afterRefresh) {
    if (job.state === 'confirmed') continue;
    if (job.state === 'failed' && raw.retryFailed !== true) continue;
    if (['sending', 'pending', 'unknown'].includes(job.state)) continue;
    jobsToSubmit.push(job);
    if (!byAccount.has(job.accountId)) byAccount.set(job.accountId, []);
    byAccount.get(job.accountId).push(job);
  }

  const automation = jobsToSubmit
    .map((job) => rowByListingId.get(String(job.channelListingId)))
    .filter((row) => row?.requiresAutomationOverride);
  if (automation.length && raw.allowDisablePriceAutomation !== true) {
    throw appError('commerce_allegro_price_sync_automation_confirmation_required', {
      count: automation.length,
      offers: automation.slice(0, 20).map((row) => row.offerId),
    });
  }

  const submittedCommands = [];
  for (const [accountId, accountJobs] of byAccount.entries()) {
    for (const part of chunks(accountJobs, BULK_LIMIT)) {
      const commandId = crypto.randomUUID();
      if (part.some((job) => job.state === 'failed')) {
        for (const job of part) {
          job.state = 'reserved';
          job.completedAt = null;
          job.lastError = '';
          job.lastErrorCode = '';
          await job.save();
        }
      }
      submittedCommands.push(await submitCommand(accountId, part, commandId));
    }
  }

  const finalJobs = trackedJobIds.size
    ? await CommercePublicationJob.find({ _id: { $in: [...trackedJobIds] } }).sort({ updatedAt: -1 }).lean()
    : [];
  return {
    stage: '3D.5',
    betaResource: true,
    marketplaceId: MARKETPLACE_ID,
    maxModificationsPerCommand: BULK_LIMIT,
    previewSummary: preview.summary,
    blocked: blocked.length,
    unresolvedListings: unresolvedListingIds.size,
    commandsSubmitted: submittedCommands.length,
    jobs: finalJobs.map((job) => ({
      jobId: job.jobId,
      productId: String(job.commerceProductId),
      accountId: job.accountId,
      listingId: String(job.channelListingId),
      offerId: job.providerEntityId,
      state: job.state,
      commandId: job.providerOperationId,
      desiredPrice: job.resultSnapshot?.desiredPrice || null,
      attempts: Number(job.attempts || 0),
      lastErrorCode: job.lastErrorCode || '',
      lastError: job.lastError || '',
    })),
  };
}

module.exports = {
  BULK_LIMIT,
  BULK_MIME,
  MARKETPLACE_ID,
  applyAllegroPriceSync,
  previewAllegroPriceSync,
  samePrice,
};
