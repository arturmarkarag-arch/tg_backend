'use strict';

const crypto = require('crypto');
const Invoice = require('../../../models/Invoice');
const InvoiceSnapshot = require('../../../models/InvoiceSnapshot');
const FiscalSubmission = require('../../../models/FiscalSubmission');
const { appError } = require('../../../utils/errors');
const { getConnectionForLegalEntity } = require('./connections');
const { getDefaultOfflineCertificate, decryptOfflinePrivateKey, touchOfflineCertificate } = require('./offlineCertificates');
const { buildInvoiceVerificationUrl, buildCertificateVerificationUrl } = require('./offlineQr');
const { getAccessToken } = require('./auth');
const { generateFa3Xml, providerBlockers } = require('./fa3');
const { validateFa3Xml } = require('./xsdValidator');
const { KSEF_SCHEMA, normalizeEnvironment } = require('./config');
const {
  openOnlineSessionWithKeyRecovery,
  sendInvoice,
  closeOnlineSession,
  getSessionStatus,
  listSessionInvoices,
  getInvoiceStatus,
  getInvoiceUpo,
} = require('./online');
const { normalizedHash, sessionStatusCode, isTerminalSessionStatus, selectInvoiceHashMatches } = require('./reconciliationPolicy');

const DEFAULT_RECONCILE_DELAY_MS = 30_000;
const AMBIGUOUS_RECONCILE_DELAY_MS = 120_000;

function serializeSubmission(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : (row || {});
  // Legal payloads stay backend-only. Routine API responses expose metadata, not XML.
  if (value.artifact && typeof value.artifact === 'object') {
    const { content, ...artifactMeta } = value.artifact;
    value.artifact = artifactMeta;
  }
  if (value.receipt && typeof value.receipt === 'object') {
    const { contentBase64, ...receiptMeta } = value.receipt;
    value.receipt = receiptMeta;
  }
  return value;
}

function errorSnapshot(error) {
  return {
    code: String(error?.code || 'ksef_unknown_error').slice(0, 120),
    message: String(error?.message || error).slice(0, 1000),
    httpStatus: Number(error?.args?.httpStatus || error?.status || 0) || null,
    providerCode: String(error?.args?.providerCode || error?.ksef?.providerCode || '').slice(0, 120),
    details: {
      ...(error?.args?.providerMessage ? { providerMessage: String(error.args.providerMessage).slice(0, 1000) } : {}),
      ...(error?.args?.retryAfter ? { retryAfter: String(error.args.retryAfter).slice(0, 120) } : {}),
    },
  };
}

function stateFromStatus(status = {}) {
  const code = Number(status?.status?.code ?? status?.code ?? 0);
  if (code === 200 && status?.ksefNumber) return 'accepted';
  if (code >= 400) return 'rejected';
  return 'processing';
}

function reconciliationValue(submission) {
  const source = submission?.reconciliation;
  const value = typeof source?.toObject === 'function' ? source.toObject() : (source || {});
  return {
    state: value.state || 'idle',
    attempts: Number(value.attempts || 0),
    nextAttemptAt: value.nextAttemptAt || null,
    leaseUntil: value.leaseUntil || null,
    lastAttemptAt: value.lastAttemptAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    completedAt: value.completedAt || null,
    lastError: value.lastError || null,
  };
}

function queueReconciliation(submission, { delayMs = DEFAULT_RECONCILE_DELAY_MS, state = 'pending', error = null } = {}) {
  const current = reconciliationValue(submission);
  const now = new Date();
  submission.reconciliation = {
    ...current,
    state,
    nextAttemptAt: new Date(now.getTime() + Math.max(0, Number(delayMs) || 0)),
    leaseUntil: null,
    lastError: error ? errorSnapshot(error) : null,
    completedAt: null,
  };
}

function completeReconciliation(submission) {
  const current = reconciliationValue(submission);
  const now = new Date();
  submission.reconciliation = {
    ...current,
    state: 'complete',
    nextAttemptAt: null,
    leaseUntil: null,
    lastSuccessAt: now,
    completedAt: now,
    lastError: null,
  };
}

function markManualReview(submission, error) {
  const current = reconciliationValue(submission);
  submission.reconciliation = {
    ...current,
    state: 'manual_review',
    nextAttemptAt: null,
    leaseUntil: null,
    completedAt: null,
    lastError: errorSnapshot(error),
  };
  submission.lastError = errorSnapshot(error);
}

async function getFinalizedInvoice(invoiceId) {
  const invoice = await Invoice.findById(invoiceId).lean();
  if (!invoice) throw appError('invoice_not_found');
  if (invoice.status !== 'finalized' || !invoice.finalizedSnapshotId) throw appError('ksef_invoice_must_be_finalized');
  const snapshot = await InvoiceSnapshot.findById(invoice.finalizedSnapshotId).lean();
  if (!snapshot?.payload) throw appError('ksef_invoice_snapshot_missing');
  return { invoice, snapshot };
}

async function buildArtifact(invoiceId) {
  const { invoice, snapshot } = await getFinalizedInvoice(invoiceId);
  const blockers = providerBlockers(snapshot.payload);
  if (blockers.length) throw appError('ksef_invoice_not_supported', { blockers });
  const xml = generateFa3Xml(snapshot.payload, { generatedAt: snapshot.createdAt });
  await validateFa3Xml(xml);
  const bytes = Buffer.from(xml, 'utf8');
  return {
    invoice, snapshot, xml,
    xmlSha256Hex: crypto.createHash('sha256').update(bytes).digest('hex'),
    xmlHashBase64: crypto.createHash('sha256').update(bytes).digest('base64'),
    xmlSize: bytes.length,
  };
}

async function validateInvoiceForKsef(invoiceId) {
  const artifact = await buildArtifact(invoiceId);
  return {
    valid: true,
    invoiceId: String(artifact.invoice._id),
    snapshotId: String(artifact.snapshot._id),
    schema: KSEF_SCHEMA,
    xmlSha256Hex: artifact.xmlSha256Hex,
    xmlSize: artifact.xmlSize,
  };
}

async function createOrGetSubmission(artifact, environment, connection, { mode = 'online' } = {}) {
  const env = normalizeEnvironment(environment);
  const requestedMode = String(mode || 'online').trim().toLowerCase();
  if (!['online', 'offline24'].includes(requestedMode)) throw appError('ksef_submission_mode_invalid');
  const existing = await FiscalSubmission.findOne({ snapshotId: artifact.snapshot._id, provider: 'ksef', environment: env });
  if (existing) return { submission: existing, created: false };
  try {
    const submission = await FiscalSubmission.create({
      invoiceId: artifact.invoice._id,
      snapshotId: artifact.snapshot._id,
      legalEntityId: artifact.invoice.seller.legalEntityId,
      connectionId: connection.connectionId,
      provider: 'ksef', environment: env, mode: requestedMode, state: 'prepared', documentSchema: KSEF_SCHEMA,
      artifact: {
        format: 'xml', mediaType: 'application/xml', content: artifact.xml,
        sha256Hex: artifact.xmlSha256Hex, hashBase64: artifact.xmlHashBase64, size: artifact.xmlSize,
      },
      providerData: { publicKeyIds: { token: '', session: '' } },
      reconciliation: { state: 'idle', attempts: 0 },
    });
    return { submission, created: true };
  } catch (error) {
    if (Number(error?.code) === 11000) {
      const submission = await FiscalSubmission.findOne({ snapshotId: artifact.snapshot._id, provider: 'ksef', environment: env });
      if (submission) return { submission, created: false };
    }
    throw error;
  }
}

async function applyProviderStatus(submission, status) {
  const state = stateFromStatus(status);
  submission.state = state;
  const providerData = { ...(submission.providerData || {}) };
  providerData.statusCode = Number(status?.status?.code ?? status?.code ?? 0) || null;
  providerData.statusDescription = String(status?.status?.description ?? status?.description ?? '').slice(0, 1000);
  providerData.statusDetails = status?.status?.details || null;
  providerData.statusExtensions = status?.status?.extensions || null;
  providerData.invoiceNumber = String(status?.invoiceNumber || providerData.invoiceNumber || '').slice(0, 200);
  providerData.permanentStorageDate = status?.permanentStorageDate ? new Date(status.permanentStorageDate) : (providerData.permanentStorageDate || null);
  providerData.upoDownloadUrl = String(status?.upoDownloadUrl || providerData.upoDownloadUrl || '').slice(0, 1000);
  submission.lastCheckedAt = new Date();
  if (status?.ksefNumber) providerData.ksefNumber = String(status.ksefNumber);
  const reconciliationWasRunning = reconciliationValue(submission).state === 'running';
  if (state === 'accepted') {
    submission.acceptedAt = status?.acquisitionDate ? new Date(status.acquisitionDate) : (submission.acceptedAt || new Date());
    submission.lastError = null;
    if (submission.receipt?.receivedAt) completeReconciliation(submission);
    else if (!reconciliationWasRunning) queueReconciliation(submission, { delayMs: 0 });
  } else if (state === 'rejected') {
    submission.rejectedAt = submission.rejectedAt || new Date();
    submission.lastError = {
      code: 'ksef_invoice_rejected',
      message: providerData.statusDescription,
      providerCode: String(providerData.statusCode || ''),
      details: providerData.statusDetails,
    };
    completeReconciliation(submission);
  } else {
    submission.lastError = null;
    if (!reconciliationWasRunning) queueReconciliation(submission);
  }
  submission.providerData = providerData;
  await submission.save();
  return submission;
}

async function refreshSubmissionStatus(submission) {
  const providerData = submission?.providerData || {};
  if (!providerData.sessionReferenceNumber || !providerData.invoiceReferenceNumber) throw appError('ksef_submission_not_sent');
  const auth = await getAccessToken(submission.connectionId);
  const status = await getInvoiceStatus(submission.environment, auth.accessToken, providerData.sessionReferenceNumber, providerData.invoiceReferenceNumber);
  return applyProviderStatus(submission, status);
}

async function bestEffortCloseSession(environment, accessToken, submission) {
  const providerData = submission?.providerData || {};
  if (!providerData.sessionReferenceNumber || providerData.closedAt) return;
  try {
    await closeOnlineSession(environment, accessToken, providerData.sessionReferenceNumber);
    submission.providerData = { ...providerData, closedAt: new Date() };
    await submission.save();
  } catch (_) {
    // Cleanup must never hide the primary send/status result.
  }
}

async function recoverAmbiguousInvoiceReference(submission, accessToken) {
  const providerData = submission?.providerData || {};
  if (providerData.invoiceReferenceNumber) return { recovered: false, pending: false };
  if (!providerData.sessionReferenceNumber) {
    const error = appError('ksef_submission_ambiguous');
    markManualReview(submission, error);
    await submission.save();
    return { recovered: false, pending: false, manualReview: true };
  }

  const invoices = await listSessionInvoices(submission.environment, accessToken, providerData.sessionReferenceNumber);
  const expectedHash = normalizedHash(submission.artifact?.hashBase64);
  const matches = selectInvoiceHashMatches(invoices, expectedHash);

  if (matches.length === 1 && matches[0]?.referenceNumber) {
    submission.providerData = {
      ...providerData,
      invoiceReferenceNumber: String(matches[0].referenceNumber),
      ambiguousSend: false,
      recoveredFromSessionAt: new Date(),
    };
    submission.state = 'processing';
    submission.lastError = null;
    queueReconciliation(submission, { delayMs: 0 });
    await submission.save();
    return { recovered: true, pending: false };
  }

  if (matches.length > 1) {
    const error = appError('ksef_submission_ambiguous_matches', { count: matches.length });
    markManualReview(submission, error);
    await submission.save();
    return { recovered: false, pending: false, manualReview: true };
  }

  const sessionStatus = await getSessionStatus(submission.environment, accessToken, providerData.sessionReferenceNumber);
  const code = sessionStatusCode(sessionStatus);
  submission.providerData = {
    ...providerData,
    sessionStatusCode: code || null,
    sessionStatusDescription: String(sessionStatus?.status?.description || '').slice(0, 1000),
    sessionLastCheckedAt: new Date(),
  };
  // 1xx session states are non-terminal. 2xx/4xx are terminal for recovery purposes.
  if (isTerminalSessionStatus(sessionStatus)) {
    const error = appError('ksef_submission_not_found_in_session', { sessionStatusCode: code });
    markManualReview(submission, error);
    await submission.save();
    return { recovered: false, pending: false, manualReview: true };
  }

  queueReconciliation(submission, { delayMs: AMBIGUOUS_RECONCILE_DELAY_MS });
  await submission.save();
  return { recovered: false, pending: true };
}

async function fetchAndStoreUpo(submission, accessToken) {
  if (submission.receipt?.receivedAt) return submission;
  const providerData = submission?.providerData || {};
  if (!providerData.sessionReferenceNumber || !providerData.invoiceReferenceNumber) throw appError('ksef_submission_not_sent');
  if (submission.state !== 'accepted') throw appError('ksef_upo_not_available');

  const result = await getInvoiceUpo(
    submission.environment,
    accessToken,
    providerData.sessionReferenceNumber,
    providerData.invoiceReferenceNumber,
  );
  const bytes = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content || '');
  const hashBase64 = crypto.createHash('sha256').update(bytes).digest('base64');
  const sha256Hex = crypto.createHash('sha256').update(bytes).digest('hex');
  const providerHashBase64 = normalizedHash(result.providerHashBase64);
  if (!providerHashBase64) throw appError('ksef_upo_hash_missing');
  if (normalizedHash(hashBase64) !== providerHashBase64) {
    throw appError('ksef_upo_hash_mismatch', { expected: providerHashBase64, actual: hashBase64 });
  }

  submission.receipt = {
    kind: 'upo',
    format: 'xml',
    mediaType: 'application/xml',
    contentBase64: bytes.toString('base64'),
    encoding: 'base64',
    sha256Hex,
    hashBase64,
    providerHashBase64,
    size: bytes.length,
    receivedAt: new Date(),
  };
  submission.providerData = { ...providerData, upoIntegrityVerified: true, upoReceivedAt: new Date() };
  completeReconciliation(submission);
  submission.lastError = null;
  await submission.save();
  return submission;
}

async function reconcileSubmissionDocument(submission) {
  const auth = await getAccessToken(submission.connectionId);
  const providerData = submission?.providerData || {};
  if (!providerData.invoiceReferenceNumber) {
    const recovery = await recoverAmbiguousInvoiceReference(submission, auth.accessToken);
    if (recovery.pending || recovery.manualReview) return submission;
  }

  const currentData = submission.providerData || {};
  const status = await getInvoiceStatus(
    submission.environment,
    auth.accessToken,
    currentData.sessionReferenceNumber,
    currentData.invoiceReferenceNumber,
  );
  await applyProviderStatus(submission, status);
  if (submission.state === 'accepted' && !submission.receipt?.receivedAt) {
    await fetchAndStoreUpo(submission, auth.accessToken);
  }
  return submission;
}

async function reconcileSubmissionById(submissionId) {
  const submission = await FiscalSubmission.findById(submissionId);
  if (!submission || submission.provider !== 'ksef') throw appError('ksef_submission_not_found');
  return reconcileSubmissionDocument(submission);
}

async function prepareOffline24Invoice(invoiceId, { environment = 'test' } = {}) {
  const env = normalizeEnvironment(environment);
  const artifact = await buildArtifact(invoiceId);
  const legalEntityId = artifact.invoice.seller?.legalEntityId;
  if (!legalEntityId) throw appError('legal_entity_required');

  // Offline issuance must not depend on current KSeF network availability, but it
  // still requires a configured local connection for the later upload/reconcile path.
  const connection = await getConnectionForLegalEntity(legalEntityId, env, { includeSecrets: false, requireEnabled: true });
  const { submission, created } = await createOrGetSubmission(artifact, env, connection, { mode: 'offline24' });
  if (submission.mode !== 'offline24') throw appError('ksef_submission_mode_conflict');

  const existingOffline = submission.providerData?.offline;
  if (existingOffline?.preparedAt && existingOffline?.qrI?.url && existingOffline?.qrII?.url) {
    return { submission: serializeSubmission(submission), alreadyPrepared: true };
  }
  if (!created && submission.state !== 'prepared') throw appError('ksef_submission_mode_conflict');

  const certificate = await getDefaultOfflineCertificate(legalEntityId, env, { includeSecret: true, requireUsable: true });
  const privateKey = decryptOfflinePrivateKey(certificate);
  const snapshotPayload = artifact.snapshot.payload || {};
  const sellerNip = String(snapshotPayload.seller?.taxId || '').replace(/\D/g, '');
  const issueDate = String(snapshotPayload.issueDate || '').trim();

  const qrIUrl = buildInvoiceVerificationUrl({
    environment: env,
    sellerNip,
    issueDate,
    invoiceHashBase64: artifact.xmlHashBase64,
  });
  const qrIIUrl = buildCertificateVerificationUrl({
    environment: env,
    contextIdentifierType: 'Nip',
    contextIdentifierValue: sellerNip,
    sellerNip,
    certificateSerialNumber: certificate.certificateSerialNumber,
    invoiceHashBase64: artifact.xmlHashBase64,
    privateKey,
  });

  submission.connectionId = connection.connectionId;
  submission.providerData = {
    ...(submission.providerData || {}),
    offline: {
      mode: 'offline24',
      preparedAt: new Date(),
      certificateId: certificate.certificateId,
      certificateSerialNumber: certificate.certificateSerialNumber,
      contextIdentifier: { type: 'Nip', value: sellerNip },
      qrI: { url: qrIUrl, label: 'OFFLINE' },
      qrII: { url: qrIIUrl, label: 'CERTYFIKAT' },
      transmissionDeadlinePolicy: 'next_business_day_after_issue_date',
    },
  };
  submission.lastError = null;
  await submission.save();
  await touchOfflineCertificate(certificate.certificateId);
  return { submission: serializeSubmission(submission), alreadyPrepared: false };
}

async function submitInvoiceToKsef(invoiceId, { environment = 'test' } = {}) {
  const env = normalizeEnvironment(environment);
  const artifact = await buildArtifact(invoiceId);
  const legalEntityId = artifact.invoice.seller?.legalEntityId;
  if (!legalEntityId) throw appError('legal_entity_required');
  const connection = await getConnectionForLegalEntity(legalEntityId, env, { includeSecrets: false, requireEnabled: true });
  const { submission } = await createOrGetSubmission(artifact, env, connection, { mode: 'online' });

  if (!['online', 'offline24'].includes(String(submission.mode || ''))) throw appError('ksef_submission_mode_invalid');
  const offlineMode = submission.mode === 'offline24';
  let providerData = submission.providerData || {};
  if (providerData.invoiceReferenceNumber) {
    if (['accepted', 'rejected'].includes(submission.state)) return { submission: serializeSubmission(submission), alreadySubmitted: true };
    const refreshed = await refreshSubmissionStatus(submission);
    return { submission: serializeSubmission(refreshed), alreadySubmitted: true };
  }
  if (providerData.sessionReferenceNumber && submission.state === 'error') {
    queueReconciliation(submission, { delayMs: 0 });
    await submission.save();
    throw appError('ksef_submission_ambiguous', { submissionId: String(submission._id) });
  }

  const auth = await getAccessToken(connection.connectionId);
  let session;
  try {
    session = await openOnlineSessionWithKeyRecovery(env, auth.accessToken);
    submission.connectionId = connection.connectionId;
    providerData = {
      ...(submission.providerData || {}),
      sessionReferenceNumber: session.sessionReferenceNumber,
      sessionValidUntil: session.validUntil ? new Date(session.validUntil) : null,
      publicKeyIds: {
        ...((submission.providerData || {}).publicKeyIds || {}),
        session: session.publicKeyId,
        ...((auth.tokenPublicKeyId && { token: auth.tokenPublicKeyId }) || {}),
      },
    };
    submission.providerData = providerData;
    submission.lastError = null;
    await submission.save();

    let sent;
    try {
      sent = await sendInvoice(env, auth.accessToken, session, submission.artifact.content, { offlineMode });
    } catch (error) {
      submission.state = 'error';
      submission.lastError = errorSnapshot(error);
      if (['ksef_api_timeout', 'ksef_api_unavailable'].includes(error?.code)) {
        submission.providerData = { ...(submission.providerData || {}), ambiguousSend: true, ambiguousSince: new Date() };
        queueReconciliation(submission, { delayMs: 0, state: 'pending', error });
      }
      await submission.save();
      await bestEffortCloseSession(env, auth.accessToken, submission);
      if (['ksef_api_timeout', 'ksef_api_unavailable'].includes(error?.code)) {
        throw appError('ksef_submission_ambiguous', { submissionId: String(submission._id) });
      }
      throw error;
    }

    providerData = { ...(submission.providerData || {}), invoiceReferenceNumber: sent.invoiceReferenceNumber, ambiguousSend: false, offlineModeSent: offlineMode };
    submission.providerData = providerData;
    submission.state = 'submitted';
    submission.submittedAt = new Date();
    submission.lastError = null;
    queueReconciliation(submission, { delayMs: 0 });
    await submission.save();

    try {
      await closeOnlineSession(env, auth.accessToken, session.sessionReferenceNumber);
      submission.providerData = { ...(submission.providerData || {}), closedAt: new Date() };
      await submission.save();
    } catch (closeError) {
      submission.lastError = errorSnapshot(closeError);
      await submission.save();
    }

    try {
      const refreshed = await refreshSubmissionStatus(submission);
      return { submission: serializeSubmission(refreshed), alreadySubmitted: false };
    } catch (_) {
      return { submission: serializeSubmission(submission), alreadySubmitted: false };
    }
  } catch (error) {
    if (!(submission.providerData || {}).invoiceReferenceNumber && submission.state !== 'error') {
      submission.state = 'error';
      submission.lastError = errorSnapshot(error);
      await submission.save();
    }
    throw error;
  }
}

async function getSubmissionStatus(invoiceId, { environment = 'test', refresh = true } = {}) {
  const env = normalizeEnvironment(environment);
  const { invoice } = await getFinalizedInvoice(invoiceId);
  const submission = await FiscalSubmission.findOne({ snapshotId: invoice.finalizedSnapshotId, provider: 'ksef', environment: env });
  if (!submission) throw appError('ksef_submission_not_found');
  if (refresh && (submission.providerData || {}).invoiceReferenceNumber && !['accepted', 'rejected'].includes(submission.state)) {
    const refreshed = await refreshSubmissionStatus(submission);
    return serializeSubmission(refreshed);
  }
  return serializeSubmission(submission);
}

async function reconcileInvoiceSubmission(invoiceId, { environment = 'test' } = {}) {
  const env = normalizeEnvironment(environment);
  const { invoice } = await getFinalizedInvoice(invoiceId);
  const submission = await FiscalSubmission.findOne({ snapshotId: invoice.finalizedSnapshotId, provider: 'ksef', environment: env });
  if (!submission) throw appError('ksef_submission_not_found');
  const reconciled = await reconcileSubmissionDocument(submission);
  return serializeSubmission(reconciled);
}

async function getSubmissionUpo(invoiceId, { environment = 'test', refresh = true } = {}) {
  const env = normalizeEnvironment(environment);
  const { invoice } = await getFinalizedInvoice(invoiceId);
  let submission = await FiscalSubmission.findOne({ snapshotId: invoice.finalizedSnapshotId, provider: 'ksef', environment: env });
  if (!submission) throw appError('ksef_submission_not_found');
  if (!submission.receipt?.receivedAt && refresh) submission = await reconcileSubmissionDocument(submission);
  if (!submission.receipt?.contentBase64) throw appError('ksef_upo_not_available');
  return {
    content: Buffer.from(submission.receipt.contentBase64, 'base64'),
    sha256Hex: submission.receipt.sha256Hex,
    hashBase64: submission.receipt.hashBase64,
    providerHashBase64: submission.receipt.providerHashBase64,
    receivedAt: submission.receipt.receivedAt,
    ksefNumber: String(submission.providerData?.ksefNumber || ''),
  };
}

module.exports = {
  validateInvoiceForKsef,
  prepareOffline24Invoice,
  submitInvoiceToKsef,
  getSubmissionStatus,
  reconcileInvoiceSubmission,
  getSubmissionUpo,
  buildArtifact,
  refreshSubmissionStatus,
  reconcileSubmissionById,
  serializeSubmission,
  errorSnapshot,
  stateFromStatus,
  normalizedHash,
  sessionStatusCode,
  queueReconciliation,
  completeReconciliation,
};
