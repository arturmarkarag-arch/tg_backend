'use strict';

const mongoose = require('mongoose');
const InboundFiscalDocument = require('../../../models/InboundFiscalDocument');
const KsefInboundSyncState = require('../../../models/KsefInboundSyncState');
const { appError } = require('../../../utils/errors');
const { ksefRequest } = require('./http');
const { validateFa3Xml } = require('./xsdValidator');
const { resolveInboundAccessToken } = require('./inboundAuth');
const { normalizeEnvironment } = require('./config');
const {
  FETCH_LEASE_MS,
  normalizeKsefNumber,
  normalizeHashBase64,
  sha256Base64,
  sha256Hex,
  isFa3Xml,
  retryDelayMs,
} = require('./inboundPolicy');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function asDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function amount(value) {
  if (value === undefined || value === null || value === '') return '';
  return clean(value, 64);
}
function safeProviderValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeProviderValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (!key || key.startsWith('$') || key.includes('.')) continue;
      out[clean(key, 128)] = safeProviderValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return String(value).slice(0, 2000);
}

function errorSnapshot(error) {
  return {
    code: clean(error?.code || 'ksef_inbound_error', 160),
    message: clean(error?.message || error, 1000),
    httpStatus: Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) || null,
    providerCode: clean(error?.args?.providerCode || error?.ksef?.providerCode || '', 160),
    details: error?.args && typeof error.args === 'object' ? safeProviderValue(error.args) : null,
  };
}

function normalizeMetadata(item = {}) {
  return {
    invoiceNumber: clean(item.invoiceNumber, 256),
    issueDate: clean(item.issueDate, 32),
    invoicingDate: asDate(item.invoicingDate),
    currency: clean(item.currency, 8).toUpperCase(),
    netAmount: amount(item.netAmount),
    vatAmount: amount(item.vatAmount),
    grossAmount: amount(item.grossAmount),
    seller: safeProviderValue(item.seller),
    buyer: safeProviderValue(item.buyer),
    thirdSubjects: Array.isArray(item.thirdSubjects) ? safeProviderValue(item.thirdSubjects) : [],
    authorizedSubject: safeProviderValue(item.authorizedSubject),
    providerDetails: safeProviderValue({
      invoicingMode: clean(item.invoicingMode, 64),
      formCode: clean(item.formCode?.systemCode || item.formCode || item.formType || '', 64),
      hashOfCorrectedInvoice: clean(item.hashOfCorrectedInvoice, 128),
    }),
  };
}

function validateMetadataIdentity(item = {}) {
  const ksefNumber = normalizeKsefNumber(item.ksefNumber);
  const invoiceHashBase64 = normalizeHashBase64(item.invoiceHash || item.fileHash);
  if (!ksefNumber) throw appError('ksef_inbound_metadata_invalid');
  if (!invoiceHashBase64) throw appError('ksef_inbound_metadata_hash_invalid');
  return { ksefNumber, invoiceHashBase64 };
}

async function upsertInboundMetadata(sync, item) {
  const { ksefNumber, invoiceHashBase64 } = validateMetadataIdentity(item);
  const metadata = normalizeMetadata(item);
  const key = {
    provider: 'ksef',
    legalEntityId: sync.legalEntityId,
    environment: sync.environment,
    providerDocumentId: ksefNumber,
  };
  let document = await InboundFiscalDocument.findOne(key);
  const now = new Date();
  if (!document) {
    try {
      document = await InboundFiscalDocument.create({
        ...key,
        sourceRole: 'buyer',
        sourceSyncId: sync.syncId,
        providerArtifactHashBase64: invoiceHashBase64,
        providerStoredAt: asDate(item.permanentStorageDate),
        metadata,
        artifactState: 'pending_fetch',
        fetch: { state: 'pending', nextAttemptAt: now },
        firstSeenAt: now,
        lastSeenAt: now,
      });
      return { status: 'created', document };
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      document = await InboundFiscalDocument.findOne(key);
    }
  }
  if (!document) throw appError('ksef_inbound_document_conflict');
  if (normalizeHashBase64(document.providerArtifactHashBase64) !== invoiceHashBase64) {
    const conflict = appError('ksef_inbound_metadata_hash_conflict', { ksefNumber });
    document.artifactState = 'manual_review';
    document.fetch.state = 'manual_review';
    document.fetch.nextAttemptAt = null;
    document.fetch.leaseUntil = null;
    document.lastSeenAt = now;
    document.lastError = errorSnapshot(conflict);
    await document.save();
    return { status: 'conflict', document };
  }
  document.metadata = metadata;
  document.sourceSyncId = sync.syncId;
  document.providerStoredAt = asDate(item.permanentStorageDate);
  document.lastSeenAt = now;
  if (!document.artifact && !['manual_review', 'fetching'].includes(document.artifactState)) {
    document.artifactState = 'pending_fetch';
    document.fetch.state = 'pending';
    document.fetch.nextAttemptAt = document.fetch.nextAttemptAt || now;
  }
  await document.save();
  return { status: 'updated', document };
}

async function upsertInboundExportMetadataBatch(sync, items, { chunkSize = 500 } = {}) {
  const normalized = [];
  const byNumber = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const { ksefNumber, invoiceHashBase64 } = validateMetadataIdentity(item);
    const previous = byNumber.get(ksefNumber);
    if (previous && previous.invoiceHashBase64 !== invoiceHashBase64) throw appError('ksef_inbound_metadata_hash_conflict', { ksefNumber });
    if (previous) continue;
    const entry = { item, ksefNumber, invoiceHashBase64, metadata: normalizeMetadata(item), providerStoredAt: asDate(item.permanentStorageDate) };
    byNumber.set(ksefNumber, entry);
    normalized.push(entry);
  }

  const rows = [];
  let created = 0;
  let updated = 0;
  let conflicts = 0;
  for (let offset = 0; offset < normalized.length; offset += Math.max(50, Math.min(1000, chunkSize))) {
    const chunk = normalized.slice(offset, offset + Math.max(50, Math.min(1000, chunkSize)));
    const ids = chunk.map((entry) => entry.ksefNumber);
    const existingRows = await InboundFiscalDocument.find({
      provider: 'ksef', legalEntityId: sync.legalEntityId, environment: sync.environment, providerDocumentId: { $in: ids },
    }).lean();
    const existingById = new Map(existingRows.map((row) => [row.providerDocumentId, row]));
    const now = new Date();
    const ops = [];
    for (const entry of chunk) {
      const existing = existingById.get(entry.ksefNumber);
      if (existing && normalizeHashBase64(existing.providerArtifactHashBase64) !== entry.invoiceHashBase64) {
        conflicts += 1;
        ops.push({ updateOne: {
          filter: { _id: existing._id },
          update: { $set: {
            artifactState: 'manual_review', 'fetch.state': 'manual_review', 'fetch.nextAttemptAt': null,
            'fetch.leaseUntil': null, lastSeenAt: now,
            lastError: errorSnapshot(appError('ksef_inbound_metadata_hash_conflict', { ksefNumber: entry.ksefNumber })),
          } },
        } });
        continue;
      }
      if (existing) updated += 1; else created += 1;
      ops.push({ updateOne: {
        filter: {
          provider: 'ksef', legalEntityId: sync.legalEntityId, environment: sync.environment, providerDocumentId: entry.ksefNumber,
        },
        update: {
          $set: {
            sourceSyncId: sync.syncId,
            providerStoredAt: entry.providerStoredAt,
            metadata: entry.metadata,
            lastSeenAt: now,
          },
          $setOnInsert: {
            provider: 'ksef', legalEntityId: sync.legalEntityId, environment: sync.environment,
            sourceRole: 'buyer', providerDocumentId: entry.ksefNumber,
            providerArtifactHashBase64: entry.invoiceHashBase64,
            artifactState: 'pending_fetch',
            fetch: { state: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null },
            firstSeenAt: now,
          },
        },
        upsert: true,
      } });
    }
    if (ops.length) await InboundFiscalDocument.bulkWrite(ops, { ordered: false });
    const refreshed = await InboundFiscalDocument.find({
      provider: 'ksef', legalEntityId: sync.legalEntityId, environment: sync.environment, providerDocumentId: { $in: ids },
    }).lean();
    rows.push(...refreshed);
  }
  return { rows, created, updated, conflicts, uniqueMetadataCount: normalized.length };
}

function publicInboundDocument(row) {
  const value = row?.toObject ? row.toObject() : { ...row };
  if (value.artifact) delete value.artifact.contentBase64;
  if (value.validation && typeof value.validation === 'object') {
    value.validation = {
      ...value.validation,
      schema: value.validation.schemaName || '',
      errors: Array.isArray(value.validation.issues) ? value.validation.issues : [],
    };
    delete value.validation.schemaName;
    delete value.validation.issues;
  }
  if (value.provider === 'ksef') {
    value.ksefNumber = value.providerDocumentId;
    value.fileHash = value.providerArtifactHashBase64;
  }
  return value;
}

async function listInboundDocuments({ legalEntityId = '', environment = '', state = '', page = 1, pageSize = 50 } = {}) {
  const filter = { provider: 'ksef' };
  if (legalEntityId) {
    if (!mongoose.isValidObjectId(String(legalEntityId))) throw appError('legal_entity_id_invalid');
    filter.legalEntityId = legalEntityId;
  }
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (state) {
    const normalizedState = clean(state, 32);
    if (!['pending_fetch', 'fetching', 'stored', 'stored_warning', 'manual_review'].includes(normalizedState)) {
      throw appError('ksef_inbound_document_state_invalid');
    }
    filter.artifactState = normalizedState;
  }
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const [rows, total] = await Promise.all([
    InboundFiscalDocument.find(filter).sort({ providerStoredAt: -1, createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeSize).limit(safeSize).lean(),
    InboundFiscalDocument.countDocuments(filter),
  ]);
  return { items: rows.map(publicInboundDocument), page: safePage, pageSize: safeSize, total };
}

async function getInboundDocument(documentId, { includeArtifact = false } = {}) {
  if (!mongoose.isValidObjectId(String(documentId || ''))) throw appError('ksef_inbound_document_id_invalid');
  let query = InboundFiscalDocument.findById(documentId);
  if (includeArtifact) query = query.select('+artifact.contentBase64');
  const document = await query;
  if (!document) throw appError('ksef_inbound_document_not_found');
  return document;
}

async function claimInboundDocument(documentId = '', now = new Date()) {
  const filter = {
    provider: 'ksef',
    artifact: null,
    artifactState: { $in: ['pending_fetch'] },
    $and: [
      { $or: [{ 'fetch.nextAttemptAt': null }, { 'fetch.nextAttemptAt': { $exists: false } }, { 'fetch.nextAttemptAt': { $lte: now } }] },
      { $or: [{ 'fetch.leaseUntil': null }, { 'fetch.leaseUntil': { $exists: false } }, { 'fetch.leaseUntil': { $lte: now } }] },
    ],
  };
  if (documentId) {
    if (!mongoose.isValidObjectId(String(documentId))) throw appError('ksef_inbound_document_id_invalid');
    filter._id = documentId;
  }
  return InboundFiscalDocument.findOneAndUpdate(filter, {
    $set: {
      artifactState: 'fetching',
      'fetch.state': 'running',
      'fetch.lastAttemptAt': now,
      'fetch.leaseUntil': new Date(now.getTime() + FETCH_LEASE_MS),
      'fetch.lastError': null,
    },
    $inc: { 'fetch.attempts': 1 },
  }, { sort: { 'fetch.nextAttemptAt': 1, createdAt: 1, _id: 1 }, new: true });
}

async function markFetchFailure(row, error) {
  const now = new Date();
  const attempts = Number(row?.fetch?.attempts || 1);
  const delay = retryDelayMs(attempts, error);
  await InboundFiscalDocument.updateOne(
    { _id: row._id, artifact: null, 'fetch.state': 'running' },
    { $set: {
      artifactState: 'pending_fetch',
      'fetch.state': 'retry_wait',
      'fetch.nextAttemptAt': new Date(now.getTime() + delay),
      'fetch.leaseUntil': null,
      'fetch.lastError': errorSnapshot(error),
      lastError: errorSnapshot(error),
    } },
  );
  return { ok: false, documentId: String(row._id), error: error?.code || 'ksef_inbound_fetch_failed', retryAfterMs: delay };
}

async function markIntegrityFailure(row, error) {
  await InboundFiscalDocument.updateOne({ _id: row._id, artifact: null }, { $set: {
    artifactState: 'manual_review',
    'fetch.state': 'manual_review',
    'fetch.nextAttemptAt': null,
    'fetch.leaseUntil': null,
    'fetch.lastError': errorSnapshot(error),
    lastError: errorSnapshot(error),
  } });
  return { ok: false, documentId: String(row._id), state: 'manual_review', error: error?.code || 'ksef_inbound_integrity_failed' };
}

async function buildArtifactPayload(row, bytes, providerHashBase64, { requireProviderHeader = true } = {}) {
  const computedBase64 = sha256Base64(bytes);
  const metadataHash = normalizeHashBase64(row.providerArtifactHashBase64);
  const providerHash = normalizeHashBase64(providerHashBase64);
  if (requireProviderHeader && !providerHash) throw appError('ksef_inbound_hash_header_missing');
  const effectiveProviderHash = providerHash || metadataHash;
  if (!metadataHash || effectiveProviderHash !== computedBase64 || metadataHash !== computedBase64) {
    throw appError('ksef_inbound_artifact_hash_mismatch', {
      ksefNumber: row.providerDocumentId,
      metadataHash,
      providerHash: effectiveProviderHash,
      computedHash: computedBase64,
    });
  }

  const xml = bytes.toString('utf8');
  let validation;
  let artifactState = 'stored';
  if (isFa3Xml(xml)) {
    try {
      await validateFa3Xml(xml);
      validation = { kind: 'xsd', state: 'valid', schemaName: 'FA(3)', checkedAt: new Date(), issues: [] };
    } catch (error) {
      const validatorUnavailable = error?.code === 'ksef_xsd_validator_unavailable';
      validation = {
        kind: 'xsd', state: validatorUnavailable ? 'unsupported' : 'invalid', schemaName: 'FA(3)', checkedAt: new Date(),
        issues: Array.isArray(error?.args?.errors) ? safeProviderValue(error.args.errors).slice(0, 50) : [{ code: clean(error?.code || 'ksef_xsd_validation_failed', 160) }],
      };
      artifactState = 'stored_warning';
    }
  } else {
    validation = { kind: 'xsd', state: 'unsupported', schemaName: 'non-FA(3)', checkedAt: new Date(), issues: [] };
    artifactState = 'stored_warning';
  }

  const now = new Date();
  const artifact = {
    format: 'xml', mediaType: 'application/xml', contentBase64: bytes.toString('base64'), encoding: 'base64',
    sha256Hex: sha256Hex(bytes), hashBase64: computedBase64, providerHashBase64: effectiveProviderHash, size: bytes.length, storedAt: now,
  };
  return { artifact, artifactState, validation, now, computedBase64 };
}

async function storeVerifiedArtifact(row, bytes, providerHashBase64) {
  const payload = await buildArtifactPayload(row, bytes, providerHashBase64, { requireProviderHeader: true });
  const result = await InboundFiscalDocument.updateOne(
    { _id: row._id, artifact: null, 'fetch.state': 'running' },
    { $set: {
      artifact: payload.artifact,
      artifactState: payload.artifactState,
      validation: payload.validation,
      'fetch.state': 'complete',
      'fetch.nextAttemptAt': null,
      'fetch.leaseUntil': null,
      'fetch.lastSuccessAt': payload.now,
      'fetch.lastError': null,
      lastError: null,
    } },
  );
  if (result.modifiedCount !== 1) {
    const existing = await getInboundDocument(row._id, { includeArtifact: true });
    if (existing.artifact?.hashBase64 !== payload.computedBase64) throw appError('ksef_inbound_document_conflict');
  }
  return getInboundDocument(row._id);
}

async function storeExportArtifact(row, bytes) {
  if (!row) throw appError('ksef_inbound_document_not_found');
  if (row.artifact) {
    if (row.artifact.hashBase64 !== sha256Base64(bytes)) throw appError('ksef_inbound_document_conflict');
    return { status: 'already_stored', document: row };
  }
  if (row.fetch?.state === 'running') return { status: 'deferred', document: row };
  const payload = await buildArtifactPayload(row, bytes, row.providerArtifactHashBase64, { requireProviderHeader: false });
  const result = await InboundFiscalDocument.updateOne(
    { _id: row._id, artifact: null, 'fetch.state': { $ne: 'running' } },
    { $set: {
      artifact: payload.artifact,
      artifactState: payload.artifactState,
      validation: payload.validation,
      'fetch.state': 'complete',
      'fetch.nextAttemptAt': null,
      'fetch.leaseUntil': null,
      'fetch.lastSuccessAt': payload.now,
      'fetch.lastError': null,
      lastError: null,
    } },
  );
  if (result.modifiedCount !== 1) {
    const existing = await getInboundDocument(row._id, { includeArtifact: true });
    if (existing.artifact?.hashBase64 === payload.computedBase64) return { status: 'already_stored', document: existing };
    if (existing.fetch?.state === 'running' && !existing.artifact) return { status: 'deferred', document: existing };
    throw appError('ksef_inbound_document_conflict');
  }
  return { status: 'stored', document: await getInboundDocument(row._id) };
}

async function processInboundDocumentClaim(row) {
  if (!row) return null;
  try {
    const sync = await KsefInboundSyncState.findOne({ syncId: row.sourceSyncId, enabled: true });
    if (!sync) throw appError('ksef_inbound_sync_disabled');
    const auth = await resolveInboundAccessToken(sync);
    const response = await ksefRequest(row.environment, `/invoices/ksef/${encodeURIComponent(row.providerDocumentId)}`, {
      token: auth.accessToken,
      responseType: 'buffer',
      accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
      timeoutMs: 30_000,
    });
    const bytes = response.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw appError('ksef_inbound_invoice_response_invalid');
    const providerHash = response.headers.get('x-ms-meta-hash') || '';
    const document = await storeVerifiedArtifact(row, bytes, providerHash);
    return { ok: true, documentId: String(row._id), state: document.artifactState, validation: document.validation?.state || '' };
  } catch (error) {
    if (['ksef_inbound_hash_header_missing', 'ksef_inbound_artifact_hash_mismatch'].includes(error?.code)) {
      return markIntegrityFailure(row, error);
    }
    return markFetchFailure(row, error);
  }
}

async function requestInboundDocumentFetch(documentId) {
  const existing = await getInboundDocument(documentId);
  if (existing.artifact) return { alreadyStored: true, queued: false, document: publicInboundDocument(existing) };
  if (existing.artifactState === 'manual_review') throw appError('ksef_inbound_document_manual_review');
  if (existing.artifactState === 'fetching' || existing.fetch?.state === 'running') {
    return { alreadyStored: false, queued: true, alreadyInProgress: true, document: publicInboundDocument(existing) };
  }
  const now = new Date();
  const result = await InboundFiscalDocument.findOneAndUpdate(
    {
      _id: existing._id,
      provider: 'ksef',
      artifact: null,
      artifactState: 'pending_fetch',
      'fetch.state': { $in: ['pending', 'retry_wait'] },
    },
    {
      $set: {
        'fetch.state': 'pending',
        'fetch.nextAttemptAt': now,
        'fetch.leaseUntil': null,
      },
    },
    { new: true },
  );
  if (!result) throw appError('ksef_inbound_document_busy');
  return { alreadyStored: false, queued: true, alreadyInProgress: false, document: publicInboundDocument(result) };
}

async function getInboundXml(documentId) {
  const document = await getInboundDocument(documentId, { includeArtifact: true });
  if (!document.artifact?.contentBase64) throw appError('ksef_inbound_artifact_not_available');
  const bytes = Buffer.from(document.artifact.contentBase64, 'base64');
  const computed = sha256Base64(bytes);
  if (computed !== document.artifact.hashBase64
    || computed !== normalizeHashBase64(document.artifact.providerHashBase64)
    || computed !== normalizeHashBase64(document.providerArtifactHashBase64)) {
    throw appError('ksef_inbound_local_artifact_hash_mismatch');
  }
  return {
    bytes,
    ksefNumber: document.providerDocumentId,
    sha256Hex: document.artifact.sha256Hex,
    hashBase64: document.artifact.hashBase64,
    validationState: document.validation?.state || '',
  };
}

module.exports = {
  clean,
  errorSnapshot,
  normalizeMetadata,
  validateMetadataIdentity,
  upsertInboundMetadata,
  upsertInboundExportMetadataBatch,
  buildArtifactPayload,
  storeExportArtifact,
  publicInboundDocument,
  listInboundDocuments,
  getInboundDocument,
  claimInboundDocument,
  processInboundDocumentClaim,
  requestInboundDocumentFetch,
  getInboundXml,
};
