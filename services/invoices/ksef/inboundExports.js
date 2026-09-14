'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const fs = require('fs');
const os = require('os');
const path = require('path');
const KsefInboundExport = require('../../../models/KsefInboundExport');
const KsefInboundSyncState = require('../../../models/KsefInboundSyncState');
const { appError } = require('../../../utils/errors');
const { encryptSecret, decryptSecret } = require('./secretStore');
const { getPublicKey, invalidatePublicKeys } = require('./publicKeys');
const { rsaOaepSha256Encrypt } = require('./crypto');
const { ksefRequest } = require('./http');
const { normalizeEnvironment } = require('./config');
const { resolveInboundAccessToken } = require('./inboundAuth');
const {
  SUBJECT_TYPE,
  MIN_SYNC_INTERVAL_MS,
  buildRequestedWindowEnd,
  buildMetadataFilters,
  asDate,
  normalizeKsefNumber,
  normalizeHashBase64,
  sha256Base64,
  retryDelayMs,
} = require('./inboundPolicy');
const {
  EXPORT_COMPRESSION,
  EXPORT_POLL_MS,
  EXPORT_RETRY_MS,
  EXPORT_LEASE_MS,
  exportKey,
  normalizeExportReference,
  parseExportStatus,
  continuationFromPackage,
  buildMetadataHashIndex,
} = require('./inboundExportPolicy');
const { downloadExportPart, decryptExportPart, forEachTarGzEntry } = require('./inboundExportArchive');
const {
  clean,
  errorSnapshot,
  upsertInboundExportMetadataBatch,
  storeExportArtifact,
} = require('./inboundDocuments');

function publicExport(row) {
  const value = row?.toObject ? row.toObject() : { ...row };
  delete value.symmetricKeyEncrypted;
  delete value.initializationVectorEncrypted;
  return value;
}

const EXPORT_STATES = new Set(['prepared', 'running', 'processing', 'retry_wait', 'complete', 'ambiguous_submit', 'manual_review']);

function objectIdString(value) {
  const id = String(value || '').trim();
  if (!mongoose.isValidObjectId(id)) throw appError('legal_entity_id_invalid');
  return id;
}

async function getInboundExport(exportId, { withSecrets = false } = {}) {
  const id = clean(exportId, 64);
  if (!id) throw appError('ksef_inbound_export_id_required');
  let query = KsefInboundExport.findOne({ exportId: id });
  if (withSecrets) query = query.select('+symmetricKeyEncrypted +initializationVectorEncrypted');
  const row = await query;
  if (!row) throw appError('ksef_inbound_export_not_found');
  return row;
}

async function listInboundExports({ syncId = '', legalEntityId = '', environment = '', state = '', page = 1, pageSize = 50 } = {}) {
  const filter = {};
  if (syncId) filter.syncId = clean(syncId, 64);
  if (legalEntityId) filter.legalEntityId = objectIdString(legalEntityId);
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (state) {
    const normalizedState = clean(state, 32);
    if (!EXPORT_STATES.has(normalizedState)) throw appError('ksef_inbound_export_state_invalid');
    filter.state = normalizedState;
  }
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const [rows, total] = await Promise.all([
    KsefInboundExport.find(filter).sort({ createdAt: -1, _id: -1 }).skip((safePage - 1) * safeSize).limit(safeSize).lean(),
    KsefInboundExport.countDocuments(filter),
  ]);
  return { items: rows.map(publicExport), page: safePage, pageSize: safeSize, total };
}

async function queueInboundExportForSync(sync, { from, to, reason = 'metadata_truncated' } = {}) {
  if (!sync?.syncId || sync.subjectType !== SUBJECT_TYPE || sync.enabled !== true) throw appError('ksef_inbound_sync_disabled');
  const start = asDate(from || sync.cursorFrom);
  const end = asDate(to || sync.activeWindowTo || buildRequestedWindowEnd(start, new Date()));
  if (!start || !end || end.getTime() < start.getTime()) throw appError('ksef_inbound_export_window_invalid');
  const key = exportKey(sync.syncId, start, end);
  let existing = await KsefInboundExport.findOne({ exportKey: key });
  if (!existing) {
    const exportId = crypto.randomUUID();
    const symmetricKey = crypto.randomBytes(32);
    const initializationVector = crypto.randomBytes(16);
    try {
      existing = await KsefInboundExport.create({
        exportId,
        exportKey: key,
        syncId: sync.syncId,
        legalEntityId: sync.legalEntityId,
        environment: sync.environment,
        subjectType: SUBJECT_TYPE,
        reason: reason === 'manual' ? 'manual' : 'metadata_truncated',
        fromPermanentStorageDate: start,
        toPermanentStorageDate: end,
        compressionType: EXPORT_COMPRESSION,
        state: 'prepared',
        symmetricKeyEncrypted: encryptSecret(symmetricKey.toString('base64'), exportId, 'inbound_export_key'),
        initializationVectorEncrypted: encryptSecret(initializationVector.toString('base64'), exportId, 'inbound_export_iv'),
        nextAttemptAt: new Date(),
      });
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      existing = await KsefInboundExport.findOne({ exportKey: key });
    }
  }
  if (!existing) throw appError('ksef_inbound_export_conflict');
  if (!['complete', 'manual_review', 'ambiguous_submit'].includes(existing.state)) {
    await KsefInboundSyncState.updateOne({ syncId: sync.syncId }, { $set: {
      state: 'export_wait', activeWindowTo: end, pageOffset: 0, nextSyncAt: null, leaseUntil: null, lastError: null,
    } });
  }
  return existing;
}

async function queueInboundExport(syncId, { toPermanentStorageDate = '' } = {}) {
  const sync = await KsefInboundSyncState.findOne({ syncId: clean(syncId, 64), enabled: true });
  if (!sync) throw appError('ksef_inbound_sync_not_found');
  if (sync.state === 'running' && sync.leaseUntil && sync.leaseUntil.getTime() > Date.now()) throw appError('ksef_inbound_sync_busy');
  const from = asDate(sync.cursorFrom);
  const to = toPermanentStorageDate ? asDate(toPermanentStorageDate) : (asDate(sync.activeWindowTo) || buildRequestedWindowEnd(from, new Date()));
  if (!to) throw appError('ksef_inbound_export_window_invalid');
  return publicExport(await queueInboundExportForSync(sync, { from, to, reason: 'manual' }));
}

function dueExportQuery(now = new Date()) {
  return {
    state: { $in: ['prepared', 'processing', 'retry_wait', 'running'] },
    $and: [
      { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
      { $or: [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
    ],
  };
}

async function claimInboundExport(exportId = '', now = new Date()) {
  const filter = dueExportQuery(now);
  if (exportId) filter.exportId = clean(exportId, 64);
  return KsefInboundExport.findOneAndUpdate(filter, {
    $set: { state: 'running', leaseUntil: new Date(now.getTime() + EXPORT_LEASE_MS), lastAttemptAt: now, lastError: null },
    $inc: { attempts: 1 },
  }, { sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 }, new: true });
}

async function loadExportSecrets(row) {
  const full = await getInboundExport(row.exportId, { withSecrets: true });
  const key = Buffer.from(decryptSecret(full.symmetricKeyEncrypted, full.exportId, 'inbound_export_key'), 'base64');
  const iv = Buffer.from(decryptSecret(full.initializationVectorEncrypted, full.exportId, 'inbound_export_iv'), 'base64');
  if (key.length !== 32 || iv.length !== 16) throw appError('ksef_inbound_export_secret_invalid');
  return { key, iv };
}

function isKeyRotation(error) {
  return String(error?.args?.providerCode || error?.ksef?.providerCode || '') === '21470';
}

async function submitExport(row, sync, auth) {
  const { key, iv } = await loadExportSecrets(row);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const publicKey = await getPublicKey(row.environment, 'SymmetricKeyEncryption', { force: attempt > 0 });
    const body = {
      encryption: {
        encryptedSymmetricKey: rsaOaepSha256Encrypt(key, publicKey.publicKey),
        initializationVector: iv.toString('base64'),
        publicKeyId: publicKey.publicKeyId,
      },
      filters: buildMetadataFilters({ from: row.fromPermanentStorageDate, to: row.toPermanentStorageDate }),
      compressionType: EXPORT_COMPRESSION,
      onlyMetadata: false,
    };
    try {
      const response = await ksefRequest(row.environment, '/invoices/exports', {
        method: 'POST', token: auth.accessToken, body, timeoutMs: 30_000,
      });
      const referenceNumber = normalizeExportReference(response.body?.referenceNumber || response.body?.operationReferenceNumber);
      if (!referenceNumber) throw appError('ksef_inbound_export_submit_response_invalid');
      const now = new Date();
      await KsefInboundExport.updateOne({ _id: row._id, state: 'running' }, { $set: {
        state: 'processing', referenceNumber, publicKeyId: publicKey.publicKeyId,
        nextAttemptAt: new Date(now.getTime() + EXPORT_POLL_MS), leaseUntil: null, lastSuccessAt: now, lastError: null,
      } });
      return { ok: true, submitted: true, referenceNumber };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isKeyRotation(error)) {
        invalidatePublicKeys(row.environment);
        continue;
      }
      throw error;
    }
  }
  throw lastError || appError('ksef_inbound_export_submit_failed');
}

function packageSnapshot(pkg) {
  return {
    invoiceCount: pkg.invoiceCount,
    size: pkg.size,
    isTruncated: pkg.isTruncated,
    lastPermanentStorageDate: pkg.lastPermanentStorageDate,
    permanentStorageHwmDate: pkg.permanentStorageHwmDate,
    parts: pkg.parts.map(({ url, ...part }) => part),
  };
}

function filenameKsefNumber(name) {
  const base = path.basename(String(name || '')).replace(/\.xml$/i, '');
  return normalizeKsefNumber(base);
}

async function processCompletedPackage(row, sync, parsed) {
  const pkg = parsed.package;
  if (pkg.packageExpirationDate && pkg.packageExpirationDate.getTime() <= Date.now()) throw appError('ksef_inbound_export_package_expired');
  if (pkg.invoiceCount === 0 && pkg.parts.length === 0) {
    const nextCursor = continuationFromPackage(pkg, row.fromPermanentStorageDate);
    if (!nextCursor) throw appError('ksef_inbound_export_hwm_invalid');
    const now = new Date();
    await KsefInboundExport.updateOne({ _id: row._id, state: 'running' }, { $set: {
      state: 'complete',
      providerStatusCode: parsed.code,
      providerStatusDescription: parsed.description,
      completedDate: pkg.completedDate,
      packageExpirationDate: pkg.packageExpirationDate,
      package: packageSnapshot(pkg),
      stats: { metadataEntries: 0, xmlEntries: 0, created: 0, updated: 0, stored: 0, alreadyStored: 0, deferred: 0, conflicts: 0 },
      nextAttemptAt: null, leaseUntil: null, lastSuccessAt: now, lastError: null,
    } });
    await KsefInboundSyncState.updateOne({ syncId: sync.syncId }, { $set: {
      state: 'idle', cursorFrom: nextCursor, activeWindowTo: null, pageOffset: 0,
      lastPermanentStorageHwmDate: pkg.permanentStorageHwmDate,
      nextSyncAt: new Date(now.getTime() + MIN_SYNC_INTERVAL_MS), leaseUntil: null, lastSuccessAt: now, lastError: null,
    } });
    return { ok: true, complete: true, empty: true, exportId: row.exportId, nextCursor: nextCursor.toISOString(), stats: { metadataEntries: 0, xmlEntries: 0 } };
  }
  if (!pkg.parts.length) throw appError('ksef_inbound_export_package_invalid');
  const names = new Set();
  for (const part of pkg.parts) {
    if (names.has(part.partName)) throw appError('ksef_inbound_export_package_invalid');
    names.add(part.partName);
  }
  const { key, iv } = await loadExportSecrets(row);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ksef-inbound-export-'));
  const archivePath = path.join(dir, 'package.tar.gz');
  let archiveSize = 0;
  try {
    for (const part of pkg.parts) {
      if (part.expirationDate.getTime() <= Date.now()) throw appError('ksef_inbound_export_part_link_expired');
      const encrypted = await downloadExportPart(part.url);
      const plain = decryptExportPart(encrypted, key, iv, part);
      await fs.promises.appendFile(archivePath, plain, { mode: 0o600 });
      archiveSize += plain.length;
    }
    if (pkg.size > 0 && archiveSize !== pkg.size) throw appError('ksef_inbound_export_package_size_mismatch');

    let metadata = null;
    await forEachTarGzEntry(archivePath, async ({ name, bytes }) => {
      if (path.basename(name).toLowerCase() !== '_metadata.json') return;
      if (metadata) throw appError('ksef_inbound_export_metadata_duplicate');
      try { metadata = JSON.parse(bytes.toString('utf8')); }
      catch (_) { throw appError('ksef_inbound_export_metadata_invalid'); }
    });
    if (!metadata || !Array.isArray(metadata.invoices)) throw appError('ksef_inbound_export_metadata_invalid');
    const hashIndex = buildMetadataHashIndex(metadata.invoices);
    const batch = await upsertInboundExportMetadataBatch(sync, metadata.invoices);
    if (batch.conflicts) throw appError('ksef_inbound_export_metadata_conflict', { conflicts: batch.conflicts });
    if (pkg.invoiceCount && pkg.invoiceCount !== batch.uniqueMetadataCount) {
      throw appError('ksef_inbound_export_invoice_count_mismatch', { packageInvoiceCount: pkg.invoiceCount, metadataCount: batch.uniqueMetadataCount });
    }

    const rowsByHash = new Map();
    for (const doc of batch.rows) {
      const hash = normalizeHashBase64(doc.providerArtifactHashBase64);
      if (!hash) continue;
      const bucket = rowsByHash.get(hash) || [];
      bucket.push(doc);
      rowsByHash.set(hash, bucket);
    }

    const seenIds = new Set();
    let xmlEntries = 0;
    let stored = 0;
    let alreadyStored = 0;
    let deferred = 0;
    await forEachTarGzEntry(archivePath, async ({ name, bytes }) => {
      if (!/\.xml$/i.test(name)) return;
      xmlEntries += 1;
      const hash = sha256Base64(bytes);
      const metadataBucket = hashIndex.get(hash) || [];
      const rowBucket = rowsByHash.get(hash) || [];
      if (!metadataBucket.length || !rowBucket.length) throw appError('ksef_inbound_export_xml_unmatched', { name });
      let row = rowBucket.length === 1 ? rowBucket[0] : null;
      if (!row) {
        const byName = filenameKsefNumber(name);
        if (byName) row = rowBucket.find((candidate) => candidate.providerDocumentId === byName) || null;
      }
      if (!row) throw appError('ksef_inbound_export_xml_ambiguous', { name });
      const id = String(row._id);
      if (seenIds.has(id)) throw appError('ksef_inbound_export_xml_duplicate', { ksefNumber: row.providerDocumentId });
      seenIds.add(id);
      const outcome = await storeExportArtifact(row, bytes);
      if (outcome.status === 'stored') stored += 1;
      else if (outcome.status === 'already_stored') alreadyStored += 1;
      else deferred += 1;
    });

    if (xmlEntries !== batch.uniqueMetadataCount || seenIds.size !== batch.uniqueMetadataCount) {
      throw appError('ksef_inbound_export_xml_count_mismatch', {
        xmlEntries, matched: seenIds.size, metadataCount: batch.uniqueMetadataCount,
      });
    }
    if (deferred) throw appError('ksef_inbound_export_document_busy', { deferred });

    const nextCursor = continuationFromPackage(pkg, row.fromPermanentStorageDate);
    if (!nextCursor) throw appError('ksef_inbound_export_hwm_invalid');
    const now = new Date();
    await KsefInboundExport.updateOne({ _id: row._id, state: 'running' }, { $set: {
      state: 'complete',
      providerStatusCode: parsed.code,
      providerStatusDescription: parsed.description,
      completedDate: pkg.completedDate,
      packageExpirationDate: pkg.packageExpirationDate,
      package: packageSnapshot(pkg),
      stats: {
        metadataEntries: batch.uniqueMetadataCount, xmlEntries, created: batch.created, updated: batch.updated,
        stored, alreadyStored, deferred: 0, conflicts: batch.conflicts,
      },
      nextAttemptAt: null, leaseUntil: null, lastSuccessAt: now, lastError: null,
    } });
    await KsefInboundSyncState.updateOne({ syncId: sync.syncId }, {
      $set: {
        state: 'idle', cursorFrom: nextCursor, activeWindowTo: null, pageOffset: 0,
        lastPermanentStorageHwmDate: pkg.permanentStorageHwmDate,
        nextSyncAt: new Date(now.getTime() + MIN_SYNC_INTERVAL_MS), leaseUntil: null, lastSuccessAt: now, lastError: null,
      },
      $inc: {
        'stats.metadataSeen': batch.uniqueMetadataCount,
        'stats.documentsCreated': batch.created,
        'stats.metadataUpdated': batch.updated,
        'stats.conflicts': batch.conflicts,
      },
    });
    return { ok: true, complete: true, exportId: row.exportId, nextCursor: nextCursor.toISOString(), stats: { ...batch, rows: undefined, xmlEntries, stored, alreadyStored } };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function classifyExportError(error) {
  const code = String(error?.code || '');
  const httpStatus = Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) || 0;
  const providerCode = String(error?.args?.providerCode || error?.ksef?.providerCode || '');
  if (code === 'ksef_rate_limited' || providerCode === '21182' || code === 'ksef_auth_failed' ||
      code === 'ksef_inbound_export_part_link_expired' || code === 'ksef_inbound_export_part_download_failed' ||
      code === 'ksef_inbound_export_part_timeout') return 'retry';
  if (code === 'ksef_api_timeout' || code === 'ksef_api_unavailable' || httpStatus >= 500) return 'ambiguous_or_retry';
  return 'terminal';
}

async function markExportFailure(row, sync, error, { beforeReference = false } = {}) {
  const kind = classifyExportError(error);
  const now = new Date();
  if (beforeReference && kind === 'ambiguous_or_retry') {
    await KsefInboundExport.updateOne({ _id: row._id }, { $set: {
      state: 'ambiguous_submit', nextAttemptAt: null, leaseUntil: null, lastError: errorSnapshot(error),
    } });
    await KsefInboundSyncState.updateOne({ syncId: sync.syncId }, { $set: {
      state: 'manual_review', nextSyncAt: null, leaseUntil: null, lastError: errorSnapshot(error),
    } });
    return { ok: false, state: 'ambiguous_submit', exportId: row.exportId, error: error?.code || 'ksef_inbound_export_failed' };
  }
  if (kind === 'retry' || (!beforeReference && kind === 'ambiguous_or_retry')) {
    const delay = Math.max(EXPORT_RETRY_MS, retryDelayMs(Number(row.attempts || 1), error, { floorMs: EXPORT_RETRY_MS }));
    await KsefInboundExport.updateOne({ _id: row._id }, { $set: {
      state: row.referenceNumber ? 'processing' : 'retry_wait', nextAttemptAt: new Date(now.getTime() + delay),
      leaseUntil: null, lastError: errorSnapshot(error),
    } });
    return { ok: false, state: 'retry_wait', exportId: row.exportId, retryAfterMs: delay, error: error?.code || 'ksef_inbound_export_failed' };
  }
  await KsefInboundExport.updateOne({ _id: row._id }, { $set: {
    state: 'manual_review', nextAttemptAt: null, leaseUntil: null, lastError: errorSnapshot(error),
  } });
  await KsefInboundSyncState.updateOne({ syncId: sync.syncId }, { $set: {
    state: 'manual_review', nextSyncAt: null, leaseUntil: null, lastError: errorSnapshot(error),
  } });
  return { ok: false, state: 'manual_review', exportId: row.exportId, error: error?.code || 'ksef_inbound_export_failed' };
}

async function processInboundExportClaim(row) {
  if (!row) return null;
  const sync = await KsefInboundSyncState.findOne({ syncId: row.syncId, enabled: true });
  if (!sync) return markExportFailure(row, { syncId: row.syncId }, appError('ksef_inbound_sync_disabled'));
  const auth = await resolveInboundAccessToken(sync);
  if (!row.referenceNumber) {
    try { return await submitExport(row, sync, auth); }
    catch (error) { return markExportFailure(row, sync, error, { beforeReference: true }); }
  }
  try {
    const response = await ksefRequest(row.environment, `/invoices/exports/${encodeURIComponent(row.referenceNumber)}`, {
      token: auth.accessToken, timeoutMs: 30_000,
    });
    let parsed;
    try { parsed = parseExportStatus(response.body); }
    catch (_) { throw appError('ksef_inbound_export_status_invalid'); }
    if (parsed.code === 100) {
      await KsefInboundExport.updateOne({ _id: row._id, state: 'running' }, { $set: {
        state: 'processing', providerStatusCode: parsed.code, providerStatusDescription: parsed.description,
        nextAttemptAt: new Date(Date.now() + EXPORT_POLL_MS), leaseUntil: null, lastError: null,
      } });
      return { ok: true, processing: true, exportId: row.exportId, statusCode: parsed.code };
    }
    if (parsed.code !== 200) throw appError('ksef_inbound_export_provider_failed', { providerCode: String(parsed.code), providerMessage: parsed.description });
    return await processCompletedPackage(row, sync, parsed);
  } catch (error) {
    return markExportFailure(row, sync, error, { beforeReference: false });
  }
}

module.exports = {
  publicExport,
  getInboundExport,
  listInboundExports,
  queueInboundExportForSync,
  queueInboundExport,
  dueExportQuery,
  claimInboundExport,
  processInboundExportClaim,
  processCompletedPackage,
  classifyExportError,
};
