'use strict';

const crypto = require('crypto');
const FiscalSubmission = require('../../../models/FiscalSubmission');
const KsefTechnicalCorrection = require('../../../models/KsefTechnicalCorrection');
const { appError } = require('../../../utils/errors');
const { normalizeEnvironment } = require('./config');
const { getAccessToken } = require('./auth');
const { buildArtifact, errorSnapshot } = require('./submissions');
const {
  openOnlineSessionWithKeyRecovery,
  sendInvoice,
  closeOnlineSession,
  listSessionInvoices,
  getSessionStatus,
  getInvoiceStatus,
  getInvoiceUpo,
} = require('./online');
const { normalizedHash, selectInvoiceHashMatches, isTerminalSessionStatus } = require('./reconciliationPolicy');

function publicTechnicalCorrection(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : { ...(row || {}) };
  if (value.correctedArtifact) delete value.correctedArtifact.content;
  if (value.receipt) delete value.receipt.contentBase64;
  return value;
}

function technicalStatusState(status = {}) {
  const code = Number(status?.status?.code ?? status?.code ?? 0);
  if (code === 200 && status?.ksefNumber) return 'accepted';
  if (code >= 400) return 'rejected';
  return 'processing';
}

async function findOriginalSubmission(invoiceId, environment) {
  const env = normalizeEnvironment(environment);
  const original = await FiscalSubmission.findOne({ invoiceId, provider: 'ksef', environment: env }).sort({ createdAt: -1 });
  if (!original) throw appError('ksef_submission_not_found');
  if (original.mode !== 'offline24') throw appError('ksef_technical_correction_offline_only');
  if (original.state !== 'rejected') throw appError('ksef_technical_correction_status_invalid');
  if (original.providerData?.ksefNumber) throw appError('ksef_technical_correction_status_invalid');
  if (!original.artifact?.hashBase64 || !original.artifact?.sha256Hex) throw appError('ksef_technical_correction_original_hash_missing');
  return original;
}

async function prepareTechnicalCorrection(invoiceId, { environment = 'test' } = {}) {
  const env = normalizeEnvironment(environment);
  const original = await findOriginalSubmission(invoiceId, env);
  const existing = await KsefTechnicalCorrection.findOne({ originalSubmissionId: original._id });
  if (existing) return { correction: publicTechnicalCorrection(existing), alreadyPrepared: true };

  const artifact = await buildArtifact(invoiceId);
  if (normalizedHash(artifact.xmlHashBase64) === normalizedHash(original.artifact.hashBase64)) {
    throw appError('ksef_technical_correction_artifact_unchanged');
  }
  let row;
  try {
    row = await KsefTechnicalCorrection.create({
      originalSubmissionId: original._id,
      invoiceId: original.invoiceId,
      snapshotId: original.snapshotId,
      legalEntityId: original.legalEntityId,
      connectionId: original.connectionId,
      environment: env,
      state: 'prepared',
      originalHashBase64: original.artifact.hashBase64,
      originalSha256Hex: original.artifact.sha256Hex,
      correctedArtifact: {
        format: 'xml', mediaType: 'application/xml', content: artifact.xml,
        sha256Hex: artifact.xmlSha256Hex, hashBase64: artifact.xmlHashBase64, size: artifact.xmlSize,
      },
      providerData: { offlineMode: true, hashOfCorrectedInvoice: original.artifact.hashBase64 },
    });
  } catch (error) {
    if (Number(error?.code) === 11000) row = await KsefTechnicalCorrection.findOne({ originalSubmissionId: original._id });
    else throw error;
  }
  return { correction: publicTechnicalCorrection(row), alreadyPrepared: false };
}

async function applyStatus(row, status) {
  const state = technicalStatusState(status);
  row.state = state;
  row.lastCheckedAt = new Date();
  row.providerData = {
    ...(row.providerData || {}),
    statusCode: Number(status?.status?.code ?? status?.code ?? 0) || null,
    statusDescription: String(status?.status?.description ?? status?.description ?? '').slice(0, 1000),
    statusDetails: status?.status?.details || null,
    ...(status?.ksefNumber ? { ksefNumber: String(status.ksefNumber) } : {}),
  };
  if (state === 'accepted') {
    row.acceptedAt = status?.acquisitionDate ? new Date(status.acquisitionDate) : (row.acceptedAt || new Date());
    row.lastError = null;
  } else if (state === 'rejected') {
    row.rejectedAt = row.rejectedAt || new Date();
    row.lastError = { code: 'ksef_technical_correction_rejected', message: row.providerData.statusDescription, providerCode: String(row.providerData.statusCode || ''), details: row.providerData.statusDetails };
  }
  await row.save();
  return row;
}

async function fetchUpo(row, accessToken) {
  if (row.receipt?.receivedAt || row.state !== 'accepted') return row;
  const pd = row.providerData || {};
  const result = await getInvoiceUpo(row.environment, accessToken, pd.sessionReferenceNumber, pd.invoiceReferenceNumber);
  const bytes = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content || '');
  const hashBase64 = crypto.createHash('sha256').update(bytes).digest('base64');
  if (!normalizedHash(result.providerHashBase64) || normalizedHash(result.providerHashBase64) !== normalizedHash(hashBase64)) {
    throw appError('ksef_upo_hash_mismatch');
  }
  row.receipt = {
    contentBase64: bytes.toString('base64'),
    sha256Hex: crypto.createHash('sha256').update(bytes).digest('hex'),
    hashBase64,
    providerHashBase64: result.providerHashBase64,
    size: bytes.length,
    receivedAt: new Date(),
  };
  await row.save();
  return row;
}

async function reconcileTechnicalCorrectionRow(row) {
  const auth = await getAccessToken(row.connectionId);
  const pd = row.providerData || {};
  if (pd.invoiceReferenceNumber) {
    const status = await getInvoiceStatus(row.environment, auth.accessToken, pd.sessionReferenceNumber, pd.invoiceReferenceNumber);
    await applyStatus(row, status);
    if (row.state === 'accepted') await fetchUpo(row, auth.accessToken);
    return row;
  }
  if (!pd.sessionReferenceNumber) throw appError('ksef_technical_correction_not_submitted');

  const invoices = await listSessionInvoices(row.environment, auth.accessToken, pd.sessionReferenceNumber);
  const matches = selectInvoiceHashMatches(invoices, normalizedHash(row.correctedArtifact?.hashBase64));
  if (matches.length === 1 && matches[0]?.referenceNumber) {
    row.providerData = { ...pd, invoiceReferenceNumber: String(matches[0].referenceNumber), ambiguousSend: false, recoveredFromSessionAt: new Date() };
    row.state = 'processing';
    row.lastError = null;
    await row.save();
    return reconcileTechnicalCorrectionRow(row);
  }
  if (matches.length > 1) {
    row.state = 'manual_review';
    row.lastError = { code: 'ksef_technical_correction_ambiguous_matches', message: 'Multiple session invoices match corrected artifact hash.' };
    await row.save();
    return row;
  }
  const sessionStatus = await getSessionStatus(row.environment, auth.accessToken, pd.sessionReferenceNumber);
  if (isTerminalSessionStatus(sessionStatus)) {
    row.state = 'manual_review';
    row.lastError = { code: 'ksef_technical_correction_not_found_in_session', message: 'Technical correction was not found in terminal KSeF session.' };
    await row.save();
  } else {
    row.state = 'processing';
    row.lastCheckedAt = new Date();
    await row.save();
  }
  return row;
}

async function submitTechnicalCorrection(correctionId) {
  const row = await KsefTechnicalCorrection.findById(correctionId).select('+receipt.contentBase64');
  if (!row) throw appError('ksef_technical_correction_not_found');
  const pd = row.providerData || {};
  if (pd.invoiceReferenceNumber || pd.sessionReferenceNumber) {
    const reconciled = await reconcileTechnicalCorrectionRow(row);
    return { correction: publicTechnicalCorrection(reconciled), alreadySubmitted: true };
  }
  if (row.state !== 'prepared') throw appError('ksef_technical_correction_state_invalid');
  const auth = await getAccessToken(row.connectionId);
  const session = await openOnlineSessionWithKeyRecovery(row.environment, auth.accessToken);
  row.providerData = { ...pd, sessionReferenceNumber: session.sessionReferenceNumber, sessionValidUntil: session.validUntil ? new Date(session.validUntil) : null, publicKeyId: session.publicKeyId };
  await row.save();
  try {
    const sent = await sendInvoice(row.environment, auth.accessToken, session, row.correctedArtifact.content, {
      offlineMode: true,
      hashOfCorrectedInvoice: row.originalHashBase64,
    });
    row.providerData = { ...(row.providerData || {}), invoiceReferenceNumber: sent.invoiceReferenceNumber, ambiguousSend: false };
    row.state = 'submitted';
    row.submittedAt = new Date();
    row.lastError = null;
    await row.save();
  } catch (error) {
    row.state = 'error';
    row.lastError = errorSnapshot(error);
    if (['ksef_api_timeout', 'ksef_api_unavailable'].includes(error?.code)) {
      row.providerData = { ...(row.providerData || {}), ambiguousSend: true, ambiguousSince: new Date() };
    }
    await row.save();
    try { await closeOnlineSession(row.environment, auth.accessToken, session.sessionReferenceNumber); } catch (_) {}
    if (['ksef_api_timeout', 'ksef_api_unavailable'].includes(error?.code)) throw appError('ksef_technical_correction_ambiguous', { correctionId: String(row._id) });
    throw error;
  }
  try { await closeOnlineSession(row.environment, auth.accessToken, session.sessionReferenceNumber); } catch (_) {}
  try { await reconcileTechnicalCorrectionRow(row); } catch (_) {}
  return { correction: publicTechnicalCorrection(row), alreadySubmitted: false };
}

async function reconcileTechnicalCorrection(correctionId) {
  const row = await KsefTechnicalCorrection.findById(correctionId).select('+receipt.contentBase64');
  if (!row) throw appError('ksef_technical_correction_not_found');
  const reconciled = await reconcileTechnicalCorrectionRow(row);
  return publicTechnicalCorrection(reconciled);
}

async function getTechnicalCorrection(correctionId) {
  const row = await KsefTechnicalCorrection.findById(correctionId);
  if (!row) throw appError('ksef_technical_correction_not_found');
  return publicTechnicalCorrection(row);
}

async function getTechnicalCorrectionUpo(correctionId) {
  let row = await KsefTechnicalCorrection.findById(correctionId).select('+receipt.contentBase64');
  if (!row) throw appError('ksef_technical_correction_not_found');
  if (!row.receipt?.contentBase64) row = await reconcileTechnicalCorrectionRow(row);
  if (!row.receipt?.contentBase64) throw appError('ksef_upo_not_available');
  return { content: Buffer.from(row.receipt.contentBase64, 'base64'), sha256Hex: row.receipt.sha256Hex, ksefNumber: String(row.providerData?.ksefNumber || '') };
}

module.exports = {
  prepareTechnicalCorrection,
  submitTechnicalCorrection,
  reconcileTechnicalCorrection,
  getTechnicalCorrection,
  getTechnicalCorrectionUpo,
  publicTechnicalCorrection,
};
