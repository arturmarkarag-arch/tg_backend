'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { previewAllegroStockSync, sameStock, wholeStock } = require('./allegroStockSync');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const ACTION = 'sync_stock';
const BULK_MIME = 'application/vnd.allegro.beta.v1+json';
const MAX_ITEMS = 250;
const BULK_LIMIT = 25;
const POST_RATE_POLICY = { key: 'sale-offer-bulk-modification-commands', limit: 100, windowMs: 60_000 };

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
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
  if (!out.length) throw appError('commerce_allegro_stock_sync_items_required');
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

async function persistStockSync(listing, patch = {}) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...allegro,
    stockSync: {
      ...(allegro.stockSync && typeof allegro.stockSync === 'object' ? allegro.stockSync : {}),
      ...patch,
      updatedAt: new Date(),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

async function requireStockWriteAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true || matrix.capabilities.saleOffersWrite !== true) {
    throw appError('commerce_allegro_stock_sync_scope_required');
  }
  return account;
}

function desiredFromJob(job) {
  return { available: wholeStock(job?.resultSnapshot?.desiredStock?.available) };
}

function actualHashFromRow(row) {
  return text(row?.actualHash, 128);
}

function jobKey(listingId, row) {
  return `allegro:${ACTION}:${text(listingId, 80)}:${text(row.desiredHash, 128)}:${actualHashFromRow(row)}`;
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
        desiredStock: { available: wholeStock(row?.desiredStock?.available) },
        observedStock: { available: wholeStock(row?.actualStock?.available) },
        observedActualHash: actualHashFromRow(row),
        publicationStatus: text(row?.publicationStatus, 40).toUpperCase(),
        wouldEndOffer: row?.wouldEndOffer === true,
      },
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return CommercePublicationJob.findOne({ idempotencyKey });
  }
}

function commandPath(commandId) {
  return `/sale/offer-bulk-modification-commands/${encodeURIComponent(commandId)}`;
}

function taskMessage(task) {
  const first = Array.isArray(task?.errors) ? task.errors[0] : null;
  return text(first?.userMessage || first?.message || task?.message || 'Allegro відхилив зміну залишку.', 1500);
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
    await persistStockSync(listing, patchFactory(job));
  }
}

function modificationForJob(job) {
  return {
    offerId: text(job.providerEntityId, 200),
    stock: {
      changeType: 'FIXED',
      value: wholeStock(desiredFromJob(job).available),
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
    desiredStock: desiredFromJob(job),
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
      stage: 'commerce_stock_sync_command',
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
      desiredStock: desiredFromJob(job), canRetry: false, lastError: '', lastErrorCode: '',
    }));
    return { state: 'pending', commandId };
  } catch (error) {
    const upstreamStatus = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
    if (upstreamStatus === 409) {
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
        job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_stock_sync_unknown';
        job.lastError = 'Результат bulk stock command невідомий. Новий commandId автоматично не створюємо; спочатку перевіряємо цей commandId.';
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
      job.lastErrorCode = text(error?.code, 160) || 'commerce_allegro_stock_sync_failed';
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
  job.lastErrorCode = text(task?.errors?.[0]?.code, 160) || 'commerce_allegro_stock_sync_task_failed';
  job.lastError = taskMessage(task);
  job.resultSnapshot = { ...(job.resultSnapshot || {}), task };
  await job.save();
  const listing = await ChannelListing.findById(job.channelListingId);
  if (listing) await persistStockSync(listing, {
    state: 'failed', desiredHash: job.requestHash, desiredStock: desiredFromJob(job), commandId: job.providerOperationId,
    jobId: job.jobId, canRetry: true, lastErrorCode: job.lastErrorCode, lastError: job.lastError,
  });
}

async function verifySuccessfulJobs(jobs) {
  if (!jobs.length) return;
  const items = jobs.map((job) => ({ productId: String(job.commerceProductId), accountId: job.accountId }));
  const preview = await previewAllegroStockSync({ items });
  const previewByKey = new Map(preview.rows.map((row) => [`${row.productId}:${row.accountId}`, row]));
  for (const job of jobs) {
    const row = previewByKey.get(`${String(job.commerceProductId)}:${job.accountId}`);
    const listing = await ChannelListing.findById(job.channelListingId);
    if (!listing) continue;
    const storedDesired = desiredFromJob(job);
    const storedAppliedHash = text(job.requestHash, 128);
    const actualMatchesStored = row ? sameStock(storedDesired, row.actualStock) : false;
    const currentDesiredHash = text(row?.desiredHash, 128);
    const stillCurrent = Boolean(currentDesiredHash) && currentDesiredHash === storedAppliedHash;
    const currentStatus = text(row?.publicationStatus, 40).toUpperCase();
    const lifecycleOk = storedDesired.available === 0 || currentStatus !== 'ENDED';

    job.state = 'confirmed';
    job.providerStatus = actualMatchesStored && lifecycleOk ? 'SUCCESS' : 'SUCCESS_BUT_DRIFT';
    job.completedAt = new Date();
    job.lastError = '';
    job.lastErrorCode = '';
    job.resultSnapshot = {
      ...(job.resultSnapshot || {}),
      verifiedAt: new Date(),
      actualStock: row?.actualStock || null,
      publicationStatus: currentStatus,
      stillCurrent,
      actualMatchesStored,
      lifecycleOk,
    };
    await job.save();

    const inSync = actualMatchesStored && stillCurrent && lifecycleOk;
    await persistStockSync(listing, {
      state: inSync ? 'confirmed' : 'out_of_sync',
      desiredHash: currentDesiredHash || storedAppliedHash,
      appliedHash: actualMatchesStored ? storedAppliedHash : '',
      desiredStock: row?.desiredStock ? { available: wholeStock(row.desiredStock.available) } : storedDesired,
      actualStock: row?.actualStock || null,
      publicationStatus: currentStatus,
      commandId: job.providerOperationId,
      jobId: job.jobId,
      verifiedAt: new Date(),
      appliedAt: actualMatchesStored ? new Date() : null,
      stillCurrent,
      canRetry: false,
      lastError: inSync ? '' : 'Bulk stock command завершився, але фактичний stock/lifecycle або поточний desired state уже відрізняються. Потрібен новий preview.',
      lastErrorCode: inSync ? '' : 'commerce_allegro_stock_sync_drift',
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
      stage: 'commerce_stock_sync_command_summary',
      accept: BULK_MIME,
    });
  } catch (error) {
    const status = Number(error?.args?.upstreamStatus || error?.allegroDiagnostic?.httpStatus || 0);
    if (status === 404) {
      for (const job of jobs) {
        if (job.state === 'unknown') {
          job.lastErrorCode = 'commerce_allegro_stock_sync_command_not_found';
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
  const completed = Boolean(summary.payload?.completedAt)
    || (Number(taskCount.total || 0) > 0 && Number(taskCount.success || 0) + Number(taskCount.failed || 0) >= Number(taskCount.total || 0));
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
    stage: 'commerce_stock_sync_command_tasks',
    accept: BULK_MIME,
  });
  const tasks = Array.isArray(detail.payload?.tasks) ? detail.payload.tasks : [];
  const taskByOffer = new Map(tasks
    .filter((task) => text(task?.subject?.field, 40) === 'stock')
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
        for (const job of group.jobs) {
          job.lastErrorCode = 'commerce_allegro_stock_sync_unknown_stale_desired';
          job.lastError = 'Command має невідомий результат, але desired stock хоча б одного offer уже змінився. Старий commandId не повторюємо.';
          await job.save();
        }
        await setListingsState(group.jobs, (job) => ({
          state: 'unknown', commandId: group.commandId, jobId: job.jobId, canRetry: false,
          lastErrorCode: job.lastErrorCode, lastError: job.lastError,
        }));
        results.push({ ...poll, replayBlockedByDrift: true });
        continue;
      }
      results.push(await submitCommand(group.accountId, group.jobs, group.commandId));
      continue;
    }
    results.push(poll);
  }
  return results;
}

async function applyAllegroStockSync(raw = {}) {
  const items = normalizeItems(raw);

  // Recovery always comes before deciding whether a fresh write is needed.
  const firstPreview = await previewAllegroStockSync({ items });
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
  if (raw.retryUnknown === true
      && raw.allowEndOffers !== true
      && existingUnresolved.some((job) => job.state === 'unknown' && desiredFromJob(job).available === 0)) {
    throw appError('commerce_allegro_stock_sync_end_confirmation_required', {
      count: existingUnresolved.filter((job) => job.state === 'unknown' && desiredFromJob(job).available === 0).length,
    });
  }
  if (existingUnresolved.length) {
    await refreshUnresolvedJobs(existingUnresolved, {
      retryUnknown: raw.retryUnknown === true,
      currentDesiredHashByListing: desiredHashByListing,
    });
  }

  // Recompute reservations, movements, Commerce Inventory and Allegro stock after recovery.
  const preview = await previewAllegroStockSync({ items });
  if (preview.reservationLedger?.mappingCoverageReady !== true) {
    throw appError('commerce_allegro_stock_sync_reservation_mapping_incomplete');
  }
  if (preview.inventoryConsumptionReady !== true) {
    throw appError('commerce_allegro_stock_sync_inventory_movements_blocked');
  }

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

  const endingRows = changes.filter((row) => row.wouldEndOffer === true);
  if (endingRows.length && raw.allowEndOffers !== true) {
    throw appError('commerce_allegro_stock_sync_end_confirmation_required', {
      count: endingRows.length,
      offers: endingRows.slice(0, 20).map((row) => row.offerId),
    });
  }

  const listingIds = changes.map((row) => row.listingId).filter(Boolean);
  const listingDocs = await ChannelListing.find({ _id: { $in: listingIds } });
  const listingById = new Map(listingDocs.map((row) => [String(row._id), row]));
  const jobs = [];
  const writeCheckedAccounts = new Set();
  for (const row of changes) {
    const listing = listingById.get(String(row.listingId));
    if (!listing) continue;
    if (!writeCheckedAccounts.has(row.accountId)) {
      await requireStockWriteAccount(row.accountId);
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
  for (const job of afterRefresh) {
    if (job.state === 'confirmed') continue;
    if (job.state === 'failed' && raw.retryFailed !== true) continue;
    if (['sending', 'pending', 'unknown'].includes(job.state)) continue;
    if (!byAccount.has(job.accountId)) byAccount.set(job.accountId, []);
    byAccount.get(job.accountId).push(job);
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
    stage: '3D.6C',
    betaResource: true,
    maxModificationsPerCommand: BULK_LIMIT,
    sourceOfTruth: 'commerce_inventory_minus_central_reservations',
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
      desiredStock: job.resultSnapshot?.desiredStock || null,
      attempts: Number(job.attempts || 0),
      lastErrorCode: job.lastErrorCode || '',
      lastError: job.lastError || '',
    })),
  };
}

module.exports = {
  ACTION,
  BULK_LIMIT,
  BULK_MIME,
  applyAllegroStockSync,
};
