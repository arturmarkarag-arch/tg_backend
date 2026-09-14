'use strict';

const mongoose = require('mongoose');
const FiscalSubmission = require('../../../models/FiscalSubmission');
const InboundFiscalDocument = require('../../../models/InboundFiscalDocument');
const KsefInboundSyncState = require('../../../models/KsefInboundSyncState');
const KsefInboundExport = require('../../../models/KsefInboundExport');
const KsefCertificateEnrollment = require('../../../models/KsefCertificateEnrollment');
const KsefTechnicalCorrection = require('../../../models/KsefTechnicalCorrection');
const KsefConnection = require('../../../models/KsefConnection');
const KsefOfflineCertificate = require('../../../models/KsefOfflineCertificate');
const KsefXadesCredential = require('../../../models/KsefXadesCredential');
const KsefXadesAuthSession = require('../../../models/KsefXadesAuthSession');
const KsefOperationalEvent = require('../../../models/KsefOperationalEvent');
const { appError } = require('../../../utils/errors');
const { normalizeEnvironment } = require('./config');
const { ksefRequest } = require('./http');
const { loadPublicKeys, getPublicKeyCacheStatus } = require('./publicKeys');
const { isKsefReconciliationSchedulerStarted } = require('./reconciliationScheduler');
const { isKsefInboundSchedulerStarted } = require('./inboundScheduler');
const { recordOperationalEvent } = require('./operationalTelemetry');
const { reconcileTechnicalCorrection } = require('./technicalCorrections');
const { reconcileCertificateEnrollment } = require('./certificateEnrollments');
const { retryIsSafe, readinessStatus } = require('./operationalPolicy');

const CERT_WARN_MS = 30 * 24 * 60 * 60 * 1000;
const CERT_CRITICAL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_STALE_MS = Math.max(60 * 60 * 1000, Number(process.env.KSEF_INBOUND_STALE_MS) || 2 * 60 * 60 * 1000);
const TOKEN_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
const ISSUE_KINDS = new Set(['fiscal_submission', 'inbound_sync', 'inbound_document', 'inbound_export', 'certificate_enrollment', 'technical_correction']);

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function objectId(value, code = 'ksef_ops_id_invalid') {
  const id = clean(value, 64);
  if (!mongoose.isValidObjectId(id)) throw appError(code);
  return id;
}
function filterScope({ environment = '', legalEntityId = '' } = {}) {
  const out = {};
  if (environment) out.environment = normalizeEnvironment(environment);
  if (legalEntityId) out.legalEntityId = objectId(legalEntityId, 'legal_entity_id_invalid');
  return out;
}
function publicError(error) {
  if (!error) return null;
  return {
    code: clean(error.code, 128), message: clean(error.message, 1000), httpStatus: Number(error.httpStatus || 0) || null,
    providerCode: clean(error.providerCode, 128), details: error.details || null,
  };
}
function issue(kind, id, row, state, lastError, extra = {}) {
  return {
    kind, id: String(id), environment: clean(row.environment, 16), legalEntityId: row.legalEntityId ? String(row.legalEntityId) : '',
    state, severity: ['ambiguous_submit', 'manual_review'].includes(state) ? 'error' : 'warn',
    lastError: publicError(lastError), updatedAt: row.updatedAt || null, createdAt: row.createdAt || null, ...extra,
  };
}

async function countReadiness(scope, now) {
  const scoped = { ...scope };
  const recentHour = new Date(now.getTime() - 60 * 60 * 1000);
  const staleSyncBefore = new Date(now.getTime() - INBOUND_STALE_MS);
  const expiryWarn = new Date(now.getTime() + CERT_WARN_MS);
  const expiryCritical = new Date(now.getTime() + CERT_CRITICAL_MS);
  const [
    submissionManual, submissionStaleLease, syncManual, syncStaleLease, syncStale,
    documentManual, documentStaleLease, exportManual, exportAmbiguous, exportStaleLease,
    enrollmentManual, enrollmentAmbiguous, technicalManual,
    connectionsWithErrors, expiredOffline, criticalOffline, warningOffline,
    expiredXades, criticalXades, warningXades, recentRateLimits, recentHttpErrors,
  ] = await Promise.all([
    FiscalSubmission.countDocuments({ provider: 'ksef', ...scoped, 'reconciliation.state': 'manual_review' }),
    FiscalSubmission.countDocuments({ provider: 'ksef', ...scoped, 'reconciliation.state': 'running', 'reconciliation.leaseUntil': { $lte: now } }),
    KsefInboundSyncState.countDocuments({ ...scoped, state: 'manual_review' }),
    KsefInboundSyncState.countDocuments({ ...scoped, state: 'running', leaseUntil: { $lte: now } }),
    KsefInboundSyncState.countDocuments({ ...scoped, enabled: true, $or: [{ lastSuccessAt: null }, { lastSuccessAt: { $lt: staleSyncBefore } }] }),
    InboundFiscalDocument.countDocuments({ provider: 'ksef', ...scoped, $or: [{ artifactState: 'manual_review' }, { 'fetch.state': 'manual_review' }] }),
    InboundFiscalDocument.countDocuments({ provider: 'ksef', ...scoped, 'fetch.state': 'running', 'fetch.leaseUntil': { $lte: now } }),
    KsefInboundExport.countDocuments({ ...scoped, state: 'manual_review' }),
    KsefInboundExport.countDocuments({ ...scoped, state: 'ambiguous_submit' }),
    KsefInboundExport.countDocuments({ ...scoped, state: 'running', leaseUntil: { $lte: now } }),
    KsefCertificateEnrollment.countDocuments({ ...scoped, state: 'manual_review' }),
    KsefCertificateEnrollment.countDocuments({ ...scoped, state: 'ambiguous_submit' }),
    KsefTechnicalCorrection.countDocuments({ ...scoped, state: 'manual_review' }),
    KsefConnection.countDocuments({ ...scoped, enabled: true, lastConnectionError: { $gt: '' } }),
    KsefOfflineCertificate.countDocuments({ ...scoped, enabled: true, validTo: { $lte: now } }),
    KsefOfflineCertificate.countDocuments({ ...scoped, enabled: true, validTo: { $gt: now, $lte: expiryCritical } }),
    KsefOfflineCertificate.countDocuments({ ...scoped, enabled: true, validTo: { $gt: expiryCritical, $lte: expiryWarn } }),
    KsefXadesCredential.countDocuments({ ...(scope.environment ? { environment: scope.environment } : {}), enabled: true, validTo: { $lte: now } }),
    KsefXadesCredential.countDocuments({ ...(scope.environment ? { environment: scope.environment } : {}), enabled: true, validTo: { $gt: now, $lte: expiryCritical } }),
    KsefXadesCredential.countDocuments({ ...(scope.environment ? { environment: scope.environment } : {}), enabled: true, validTo: { $gt: expiryCritical, $lte: expiryWarn } }),
    KsefOperationalEvent.countDocuments({ ...(scope.environment ? { environment: scope.environment } : {}), kind: 'rate_limit', at: { $gte: recentHour } }),
    KsefOperationalEvent.countDocuments({ ...(scope.environment ? { environment: scope.environment } : {}), kind: 'http_error', at: { $gte: recentHour } }),
  ]);
  return {
    manualReview: { submissions: submissionManual, inboundSyncs: syncManual, inboundDocuments: documentManual, inboundExports: exportManual, enrollments: enrollmentManual, technicalCorrections: technicalManual },
    ambiguous: { inboundExports: exportAmbiguous, enrollments: enrollmentAmbiguous },
    staleLeases: { submissions: submissionStaleLease, inboundSyncs: syncStaleLease, inboundDocuments: documentStaleLease, inboundExports: exportStaleLease },
    staleInboundSyncs: syncStale,
    credentials: {
      tokenConnectionsWithErrors: connectionsWithErrors,
      offlineCertificates: { expired: expiredOffline, expiresWithin7d: criticalOffline, expiresWithin30d: warningOffline },
      xadesCredentials: { expired: expiredXades, expiresWithin7d: criticalXades, expiresWithin30d: warningXades },
    },
    telemetryLastHour: { rateLimited: recentRateLimits, httpErrors: recentHttpErrors },
  };
}

async function getKsefReadiness(options = {}) {
  const scope = filterScope(options);
  const now = new Date();
  const counts = await countReadiness(scope, now);
  const operational = (() => { try { return require('./operationalScheduler').isKsefOperationalSchedulerStarted(); } catch (_) { return false; } })();
  const schedulers = {
    reconciliation: isKsefReconciliationSchedulerStarted(),
    inbound: isKsefInboundSchedulerStarted(),
    operational,
    reconciliationExpected: String(process.env.KSEF_RECONCILIATION_ENABLED || 'true').toLowerCase() !== 'false',
    inboundExpected: String(process.env.KSEF_INBOUND_SYNC_ENABLED || 'true').toLowerCase() !== 'false',
    operationalExpected: String(process.env.KSEF_OPERATIONS_ENABLED || 'true').toLowerCase() !== 'false',
  };
  const blockers = [];
  const warnings = [];
  if (schedulers.reconciliationExpected && !schedulers.reconciliation) blockers.push('reconciliation_scheduler_not_started');
  if (schedulers.inboundExpected && !schedulers.inbound) blockers.push('inbound_scheduler_not_started');
  if (schedulers.operationalExpected && !schedulers.operational) blockers.push('operational_scheduler_not_started');
  const staleLeaseTotal = Object.values(counts.staleLeases).reduce((a, b) => a + b, 0);
  if (staleLeaseTotal) blockers.push('stale_leases_present');
  if (counts.credentials.offlineCertificates.expired || counts.credentials.xadesCredentials.expired) blockers.push('expired_enabled_certificate');
  if (counts.credentials.offlineCertificates.expiresWithin7d || counts.credentials.xadesCredentials.expiresWithin7d) warnings.push('certificate_expires_within_7d');
  if (counts.credentials.offlineCertificates.expiresWithin30d || counts.credentials.xadesCredentials.expiresWithin30d) warnings.push('certificate_expires_within_30d');
  if (counts.staleInboundSyncs) warnings.push('inbound_sync_stale');
  if (Object.values(counts.manualReview).some(Boolean)) warnings.push('manual_review_present');
  if (Object.values(counts.ambiguous).some(Boolean)) warnings.push('ambiguous_operation_present');
  if (counts.telemetryLastHour.rateLimited) warnings.push('recent_rate_limit');
  if (counts.credentials.tokenConnectionsWithErrors) warnings.push('connection_errors_present');
  return {
    status: readinessStatus(blockers, warnings),
    checkedAt: now,
    scope: { environment: scope.environment || '', legalEntityId: scope.legalEntityId ? String(scope.legalEntityId) : '' },
    schedulers, blockers, warnings, counts,
    publicKeyCache: getPublicKeyCacheStatus(scope.environment || ''),
  };
}

async function listOperationalIssues({ environment = '', legalEntityId = '', kind = '', limit = 100 } = {}) {
  const scope = filterScope({ environment, legalEntityId });
  const normalizedKind = clean(kind, 64);
  if (normalizedKind && !ISSUE_KINDS.has(normalizedKind)) throw appError('ksef_ops_issue_kind_invalid');
  const max = Math.max(1, Math.min(200, Number(limit) || 100));
  const jobs = [];
  if (!normalizedKind || normalizedKind === 'fiscal_submission') jobs.push(FiscalSubmission.find({ provider: 'ksef', ...scope, $or: [{ 'reconciliation.state': 'manual_review' }, { state: 'error' }] }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('fiscal_submission', r._id, r, r.reconciliation?.state === 'manual_review' ? 'manual_review' : r.state, r.reconciliation?.lastError || r.lastError, { invoiceId: String(r.invoiceId || '') }))));
  if (!normalizedKind || normalizedKind === 'inbound_sync') jobs.push(KsefInboundSyncState.find({ ...scope, state: 'manual_review' }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('inbound_sync', r.syncId, r, r.state, r.lastError))));
  if (!normalizedKind || normalizedKind === 'inbound_document') jobs.push(InboundFiscalDocument.find({ provider: 'ksef', ...scope, $or: [{ artifactState: 'manual_review' }, { 'fetch.state': 'manual_review' }] }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('inbound_document', r._id, r, 'manual_review', r.fetch?.lastError || r.lastError, { providerDocumentId: r.providerDocumentId }))));
  if (!normalizedKind || normalizedKind === 'inbound_export') jobs.push(KsefInboundExport.find({ ...scope, state: { $in: ['manual_review', 'ambiguous_submit'] } }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('inbound_export', r.exportId, r, r.state, r.lastError, { referenceNumber: r.referenceNumber || '' }))));
  if (!normalizedKind || normalizedKind === 'certificate_enrollment') jobs.push(KsefCertificateEnrollment.find({ ...scope, state: { $in: ['manual_review', 'ambiguous_submit', 'failed'] } }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('certificate_enrollment', r.enrollmentId, r, r.state, { code: r.lastErrorCode, message: r.lastErrorMessage }, { referenceNumber: r.referenceNumber || '', certificateType: r.certificateType }))));
  if (!normalizedKind || normalizedKind === 'technical_correction') jobs.push(KsefTechnicalCorrection.find({ ...scope, state: { $in: ['manual_review', 'error', 'rejected'] } }).sort({ updatedAt: -1 }).limit(max).lean().then(rows => rows.map(r => issue('technical_correction', r._id, r, r.state, r.lastError, { invoiceId: String(r.invoiceId || '') }))));
  const groups = await Promise.all(jobs);
  return groups.flat().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, max);
}

async function retryOperationalIssue(kind, id, actor = null) {
  const normalizedKind = clean(kind, 64);
  if (!ISSUE_KINDS.has(normalizedKind)) throw appError('ksef_ops_issue_kind_invalid');
  const now = new Date();
  let result;
  if (normalizedKind === 'fiscal_submission') {
    const _id = objectId(id);
    const row = await FiscalSubmission.findOne({ _id, provider: 'ksef' });
    if (!row) throw appError('ksef_submission_not_found');
    if (!retryIsSafe(normalizedKind, row)) throw appError('ksef_ops_retry_not_safe');
    row.reconciliation = { ...(row.reconciliation?.toObject?.() || row.reconciliation || {}), state: 'pending', nextAttemptAt: now, leaseUntil: null, lastError: null, completedAt: null };
    await row.save();
    result = { kind: normalizedKind, id: String(row._id), state: 'pending' };
  } else if (normalizedKind === 'inbound_sync') {
    const existing = await KsefInboundSyncState.findOne({ syncId: clean(id, 64) });
    if (!existing || !retryIsSafe(normalizedKind, existing)) throw appError('ksef_ops_retry_not_safe');
    const row = await KsefInboundSyncState.findOneAndUpdate({ _id: existing._id, state: 'manual_review', enabled: true }, { $set: { state: 'idle', nextSyncAt: now, leaseUntil: null, lastError: null } }, { new: true });
    result = { kind: normalizedKind, id: row.syncId, state: row.state };
  } else if (normalizedKind === 'inbound_document') {
    const _id = objectId(id);
    const existing = await InboundFiscalDocument.findOne({ _id, provider: 'ksef' });
    if (!existing || !retryIsSafe(normalizedKind, existing)) throw appError('ksef_ops_retry_not_safe');
    const row = await InboundFiscalDocument.findOneAndUpdate({ _id: existing._id }, { $set: { artifactState: 'pending_fetch', 'fetch.state': 'pending', 'fetch.nextAttemptAt': now, 'fetch.leaseUntil': null, 'fetch.lastError': null, lastError: null } }, { new: true });
    result = { kind: normalizedKind, id: String(row._id), state: row.fetch?.state || 'pending' };
  } else if (normalizedKind === 'inbound_export') {
    const row = await KsefInboundExport.findOne({ exportId: clean(id, 64) });
    if (!row) throw appError('ksef_inbound_export_not_found');
    if (!retryIsSafe(normalizedKind, row)) throw appError('ksef_ops_retry_not_safe');
    row.state = 'processing'; row.nextAttemptAt = now; row.leaseUntil = null; row.lastError = null; await row.save();
    result = { kind: normalizedKind, id: row.exportId, state: row.state };
  } else if (normalizedKind === 'certificate_enrollment') {
    const row = await KsefCertificateEnrollment.findOne({ enrollmentId: clean(id, 64) });
    if (!row) throw appError('ksef_certificate_enrollment_not_found');
    if (!retryIsSafe(normalizedKind, row)) throw appError('ksef_ops_retry_not_safe');
    const reconciled = await reconcileCertificateEnrollment(row.enrollmentId);
    result = { kind: normalizedKind, id: row.enrollmentId, state: reconciled.state };
  } else if (normalizedKind === 'technical_correction') {
    const _id = objectId(id);
    const row = await KsefTechnicalCorrection.findById(_id).lean();
    if (!row) throw appError('ksef_technical_correction_not_found');
    if (!retryIsSafe(normalizedKind, row)) throw appError('ksef_ops_retry_not_safe');
    const reconciled = await reconcileTechnicalCorrection(_id);
    result = { kind: normalizedKind, id: String(_id), state: reconciled.state };
  }
  await recordOperationalEvent({ kind: 'admin_retry', severity: 'info', resourceType: normalizedKind, resourceId: String(id), actor, message: 'KSeF operational issue retry requested', details: { resultState: result?.state || '' } });
  return result;
}

async function recoverStaleKsefLeases({ actor = null, source = 'startup' } = {}) {
  const now = new Date();
  const recoveryError = { code: 'ksef_restart_recovery', message: 'Expired lease recovered after process interruption.' };
  const ambiguousError = { code: 'ksef_inbound_export_restart_ambiguous', message: 'Process stopped while export submission may have been in flight; POST is not replayed automatically.' };
  const [submissions, syncs, documents, exportsPolling, exportsAmbiguous] = await Promise.all([
    FiscalSubmission.updateMany({ provider: 'ksef', 'reconciliation.state': 'running', 'reconciliation.leaseUntil': { $lte: now } }, { $set: { 'reconciliation.state': 'pending', 'reconciliation.nextAttemptAt': now, 'reconciliation.leaseUntil': null, 'reconciliation.lastError': recoveryError } }),
    KsefInboundSyncState.updateMany({ state: 'running', leaseUntil: { $lte: now } }, { $set: { state: 'idle', nextSyncAt: now, leaseUntil: null, lastError: recoveryError } }),
    InboundFiscalDocument.updateMany({ provider: 'ksef', 'fetch.state': 'running', 'fetch.leaseUntil': { $lte: now } }, { $set: { artifactState: 'pending_fetch', 'fetch.state': 'pending', 'fetch.nextAttemptAt': now, 'fetch.leaseUntil': null, 'fetch.lastError': recoveryError, lastError: recoveryError } }),
    KsefInboundExport.updateMany({ state: 'running', leaseUntil: { $lte: now }, referenceNumber: { $gt: '' } }, { $set: { state: 'processing', nextAttemptAt: now, leaseUntil: null, lastError: recoveryError } }),
    KsefInboundExport.updateMany({ state: 'running', leaseUntil: { $lte: now }, $or: [{ referenceNumber: '' }, { referenceNumber: null }, { referenceNumber: { $exists: false } }] }, { $set: { state: 'ambiguous_submit', nextAttemptAt: null, leaseUntil: null, lastError: ambiguousError } }),
  ]);
  const counts = {
    fiscalSubmissions: submissions.modifiedCount || 0,
    inboundSyncs: syncs.modifiedCount || 0,
    inboundDocuments: documents.modifiedCount || 0,
    inboundExportsPolling: exportsPolling.modifiedCount || 0,
    inboundExportsAmbiguous: exportsAmbiguous.modifiedCount || 0,
  };
  if (Object.values(counts).some(Boolean)) await recordOperationalEvent({ kind: 'restart_recovery', severity: counts.inboundExportsAmbiguous ? 'warn' : 'info', actor, message: `KSeF stale lease recovery (${source})`, details: counts });
  return counts;
}

async function cleanupKsefOperationalState({ actor = null } = {}) {
  const cutoff = new Date(Date.now() - TOKEN_CLEANUP_GRACE_MS);
  const [sessions, connections] = await Promise.all([
    KsefXadesAuthSession.deleteMany({ refreshTokenValidUntil: { $lt: cutoff }, accessTokenValidUntil: { $lt: cutoff } }),
    KsefConnection.updateMany({ refreshTokenValidUntil: { $lt: cutoff }, accessTokenValidUntil: { $lt: cutoff } }, { $unset: { accessTokenEncrypted: 1, refreshTokenEncrypted: 1 }, $set: { accessTokenValidUntil: null, refreshTokenValidUntil: null } }),
  ]);
  const result = { expiredXadesAuthSessionsDeleted: sessions.deletedCount || 0, expiredTokenConnectionCachesCleared: connections.modifiedCount || 0 };
  if (Object.values(result).some(Boolean)) await recordOperationalEvent({ kind: 'cleanup', severity: 'info', actor, message: 'Expired KSeF transient auth state cleaned', details: result });
  return result;
}

async function probeKsefEnvironment(environment, actor = null) {
  const env = normalizeEnvironment(environment);
  const started = Date.now();
  try {
    const [rateResponse, keys] = await Promise.all([
      ksefRequest(env, '/rate-limits', { timeoutMs: 10_000 }),
      loadPublicKeys(env, { force: true }),
    ]);
    const result = {
      ok: true, environment: env, checkedAt: new Date(), durationMs: Date.now() - started,
      rateLimits: rateResponse.body,
      publicKeys: keys.map(k => ({ publicKeyId: clean(k.publicKeyId, 160), certificateId: clean(k.certificateId, 160), usage: Array.isArray(k.usage) ? k.usage.slice(0, 8) : [], validFrom: k.validFrom || null, validTo: k.validTo || null })),
    };
    await recordOperationalEvent({ kind: 'probe', severity: 'info', environment: env, actor, message: 'KSeF public readiness probe passed', details: { durationMs: result.durationMs, publicKeyCount: result.publicKeys.length } });
    return result;
  } catch (error) {
    await recordOperationalEvent({ kind: 'probe', severity: 'error', environment: env, actor, code: error?.code || 'ksef_probe_failed', message: error?.message || 'KSeF probe failed', details: { durationMs: Date.now() - started } });
    throw error;
  }
}

async function listOperationalEvents({ environment = '', kind = '', severity = '', page = 1, pageSize = 50 } = {}) {
  const filter = {};
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (kind) filter.kind = clean(kind, 64);
  if (severity) {
    const value = clean(severity, 16);
    if (!['info', 'warn', 'error'].includes(value)) throw appError('ksef_ops_severity_invalid');
    filter.severity = value;
  }
  const safePage = Math.max(1, Number(page) || 1); const safeSize = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const [items, total] = await Promise.all([
    KsefOperationalEvent.find(filter).sort({ at: -1, _id: -1 }).skip((safePage - 1) * safeSize).limit(safeSize).lean(),
    KsefOperationalEvent.countDocuments(filter),
  ]);
  return { items, page: safePage, pageSize: safeSize, total };
}

module.exports = {
  getKsefReadiness,
  listOperationalIssues,
  retryOperationalIssue,
  recoverStaleKsefLeases,
  cleanupKsefOperationalState,
  probeKsefEnvironment,
  listOperationalEvents,
  ISSUE_KINDS,
};
