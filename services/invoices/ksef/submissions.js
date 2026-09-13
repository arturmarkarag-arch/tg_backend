'use strict';

const crypto = require('crypto');
const Invoice = require('../../../models/Invoice');
const InvoiceSnapshot = require('../../../models/InvoiceSnapshot');
const FiscalSubmission = require('../../../models/FiscalSubmission');
const { appError } = require('../../../utils/errors');
const { getConnectionForLegalEntity } = require('./connections');
const { getAccessToken } = require('./auth');
const { generateFa3Xml, providerBlockers } = require('./fa3');
const { validateFa3Xml } = require('./xsdValidator');
const { KSEF_SCHEMA, normalizeEnvironment } = require('./config');
const { openOnlineSessionWithKeyRecovery, sendInvoice, closeOnlineSession, getInvoiceStatus } = require('./online');

function serializeSubmission(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : (row || {});
  // Artifact content is an internal legal payload; routine API responses expose metadata only.
  if (value.artifact && typeof value.artifact === 'object') {
    const { content, ...artifactMeta } = value.artifact;
    value.artifact = artifactMeta;
  }
  return value;
}
function errorSnapshot(error) {
  return {
    code: String(error?.code || 'ksef_unknown_error').slice(0, 120),
    message: String(error?.message || error).slice(0, 1000),
    httpStatus: Number(error?.args?.httpStatus || error?.status || 0) || null,
    providerCode: String(error?.args?.providerCode || error?.ksef?.providerCode || '').slice(0, 120),
    details: error?.args?.providerMessage ? { providerMessage: String(error.args.providerMessage).slice(0, 1000) } : null,
  };
}
function stateFromStatus(status = {}) {
  const code = Number(status?.status?.code ?? status?.code ?? 0);
  if (code === 200 && status?.ksefNumber) return 'accepted';
  if (code >= 400) return 'rejected';
  return 'processing';
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

async function createOrGetSubmission(artifact, environment, connection) {
  const env = normalizeEnvironment(environment);
  const existing = await FiscalSubmission.findOne({ snapshotId: artifact.snapshot._id, provider: 'ksef', environment: env });
  if (existing) return { submission: existing, created: false };
  try {
    const submission = await FiscalSubmission.create({
      invoiceId: artifact.invoice._id,
      snapshotId: artifact.snapshot._id,
      legalEntityId: artifact.invoice.seller.legalEntityId,
      connectionId: connection.connectionId,
      provider: 'ksef', environment: env, mode: 'online', state: 'prepared', documentSchema: KSEF_SCHEMA,
      artifact: {
        format: 'xml', mediaType: 'application/xml', content: artifact.xml,
        sha256Hex: artifact.xmlSha256Hex, hashBase64: artifact.xmlHashBase64, size: artifact.xmlSize,
      },
      providerData: { publicKeyIds: { token: '', session: '' } },
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
  submission.lastCheckedAt = new Date();
  if (status?.ksefNumber) providerData.ksefNumber = String(status.ksefNumber);
  if (state === 'accepted') submission.acceptedAt = status?.acquisitionDate ? new Date(status.acquisitionDate) : new Date();
  if (state === 'rejected') submission.rejectedAt = new Date();
  submission.lastError = state === 'rejected'
    ? { code: 'ksef_invoice_rejected', message: providerData.statusDescription, providerCode: String(providerData.statusCode || ''), details: providerData.statusDetails }
    : null;
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
  } catch (error) {
    // Closing a session is cleanup. Preserve the original send/status failure as the
    // primary error instead of masking it with a cleanup failure.
  }
}

async function submitInvoiceToKsef(invoiceId, { environment = 'test' } = {}) {
  const env = normalizeEnvironment(environment);
  const artifact = await buildArtifact(invoiceId);
  const legalEntityId = artifact.invoice.seller?.legalEntityId;
  if (!legalEntityId) throw appError('legal_entity_required');
  const connection = await getConnectionForLegalEntity(legalEntityId, env, { includeSecrets: false, requireEnabled: true });
  const { submission } = await createOrGetSubmission(artifact, env, connection);

  let providerData = submission.providerData || {};
  if (providerData.invoiceReferenceNumber) {
    if (['accepted', 'rejected'].includes(submission.state)) return { submission: serializeSubmission(submission), alreadySubmitted: true };
    const refreshed = await refreshSubmissionStatus(submission);
    return { submission: serializeSubmission(refreshed), alreadySubmitted: true };
  }
  if (providerData.sessionReferenceNumber && submission.state === 'error') {
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
      sent = await sendInvoice(env, auth.accessToken, session, submission.artifact.content);
    } catch (error) {
      submission.state = 'error';
      submission.lastError = errorSnapshot(error);
      await submission.save();
      await bestEffortCloseSession(env, auth.accessToken, submission);
      if (['ksef_api_timeout', 'ksef_api_unavailable'].includes(error?.code)) {
        throw appError('ksef_submission_ambiguous', { submissionId: String(submission._id) });
      }
      throw error;
    }

    providerData = { ...(submission.providerData || {}), invoiceReferenceNumber: sent.invoiceReferenceNumber };
    submission.providerData = providerData;
    submission.state = 'submitted';
    submission.submittedAt = new Date();
    submission.lastError = null;
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
      submission.state = 'error'; submission.lastError = errorSnapshot(error); await submission.save();
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

module.exports = { validateInvoiceForKsef, submitInvoiceToKsef, getSubmissionStatus, buildArtifact, refreshSubmissionStatus, serializeSubmission };
