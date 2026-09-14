'use strict';

const crypto = require('crypto');
const KsefXadesCredential = require('../../../models/KsefXadesCredential');
const KsefXadesAuthSession = require('../../../models/KsefXadesAuthSession');
const { appError } = require('../../../utils/errors');
const { normalizeEnvironment } = require('./config');
const { encryptSecret, decryptSecret, fingerprint } = require('./secretStore');
const {
  inspectXadesCredential,
  assertCertificateCurrentlyValid,
  validateSubjectIdentifierType,
} = require('./xadesCrypto');
const { extractKeyUsageBitsFromDer } = require('./offlineCertificateCrypto');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function secretScope(credentialId) { return `xades-${clean(credentialId, 64)}`; }

function publicXadesCredential(value) {
  const row = typeof value?.toObject === 'function' ? value.toObject() : (value || {});
  return {
    credentialId: clean(row.credentialId, 64),
    environment: clean(row.environment, 20),
    credentialName: clean(row.credentialName, 200),
    source: row.source || 'manual_import',
    certificateType: row.certificateType || 'External',
    subjectIdentifierType: row.subjectIdentifierType || 'certificateSubject',
    verifyCertificateChain: row.verifyCertificateChain !== false,
    enabled: row.enabled === true,
    certificateSerialNumber: clean(row.certificateSerialNumber, 128),
    certificateSha256Hex: clean(row.certificateSha256Hex, 128),
    keyAlgorithm: row.keyAlgorithm || '',
    keyDetails: row.keyDetails || null,
    subject: row.subject || '',
    issuer: row.issuer || '',
    validFrom: row.validFrom || null,
    validTo: row.validTo || null,
    lastAuthAt: row.lastAuthAt || null,
    lastConnectionCheckAt: row.lastConnectionCheckAt || null,
    lastConnectionError: row.lastConnectionError || '',
    revokedAt: row.revokedAt || null,
    importedAt: row.importedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function assertAuthenticationCertificateUsage(certificate) {
  try {
    const usage = extractKeyUsageBitsFromDer(certificate.raw);
    if (!usage.digitalSignature || usage.contentCommitment) throw new Error('wrong usage');
    return usage;
  } catch (_) {
    throw appError('ksef_xades_authentication_certificate_usage_invalid');
  }
}

async function storeCredential({
  environment,
  credentialName = '',
  certificateBase64,
  privateKey,
  certificateType = 'External',
  subjectIdentifierType = 'certificateSubject',
  verifyCertificateChain = true,
  enabled = true,
  source = 'manual_import',
} = {}) {
  const env = normalizeEnvironment(environment);
  const certType = String(certificateType || 'External').trim();
  if (!['External', 'Authentication'].includes(certType)) throw appError('ksef_xades_certificate_type_invalid');
  const subjectType = validateSubjectIdentifierType(subjectIdentifierType);
  const inspected = inspectXadesCredential(certificateBase64, privateKey);
  if (!inspected.certificateSerialNumber) throw appError('ksef_xades_certificate_invalid');
  if (certType === 'Authentication') assertAuthenticationCertificateUsage(inspected.certificate);
  const canonicalPrivateKey = inspected.canonicalPrivateKeyPem;
  const privateKeyFingerprint = fingerprint(canonicalPrivateKey);
  const chainVerification = env === 'test' ? verifyCertificateChain !== false : true;

  let credential = await KsefXadesCredential.findOne({ environment: env, certificateSerialNumber: inspected.certificateSerialNumber })
    .select('+privateKeyFingerprint');
  if (credential) {
    if (credential.certificateSha256Hex !== inspected.certificateSha256Hex || credential.privateKeyFingerprint !== privateKeyFingerprint) {
      throw appError('ksef_xades_credential_conflict');
    }
    const authContractChanged = credential.subjectIdentifierType !== subjectType || credential.verifyCertificateChain !== chainVerification;
    credential.credentialName = clean(credentialName || credential.credentialName, 200);
    credential.certificateType = certType;
    credential.subjectIdentifierType = subjectType;
    credential.verifyCertificateChain = chainVerification;
    credential.enabled = enabled !== false;
    credential.validFrom = inspected.validFrom;
    credential.validTo = inspected.validTo;
    credential.subject = inspected.subject;
    credential.issuer = inspected.issuer;
    credential.keyAlgorithm = inspected.keyAlgorithm;
    credential.keyDetails = inspected.keyDetails;
    credential.revokedAt = null;
    credential.source = source;
    await credential.save();
    if (authContractChanged) await KsefXadesAuthSession.deleteMany({ credentialId: credential.credentialId });
    return credential;
  }

  const credentialId = crypto.randomUUID();
  credential = new KsefXadesCredential({
    credentialId,
    environment: env,
    credentialName: clean(credentialName, 200),
    source,
    certificateType: certType,
    subjectIdentifierType: subjectType,
    verifyCertificateChain: chainVerification,
    enabled: enabled !== false,
    certificateBase64: inspected.certificateBase64,
    certificateSha256Hex: inspected.certificateSha256Hex,
    certificateSerialNumber: inspected.certificateSerialNumber,
    privateKeyEncrypted: encryptSecret(canonicalPrivateKey, secretScope(credentialId), 'xades-private-key'),
    privateKeyFingerprint,
    keyAlgorithm: inspected.keyAlgorithm,
    keyDetails: inspected.keyDetails,
    subject: inspected.subject,
    issuer: inspected.issuer,
    validFrom: inspected.validFrom,
    validTo: inspected.validTo,
    importedAt: new Date(),
  });
  try {
    await credential.save();
  } catch (error) {
    if (Number(error?.code) === 11000) throw appError('ksef_xades_credential_conflict');
    throw error;
  }
  return credential;
}

async function importXadesCredential(input = {}) {
  return publicXadesCredential(await storeCredential({ ...input, source: 'manual_import' }));
}

async function storeIssuedAuthenticationCredential(input = {}) {
  const credential = await storeCredential({
    ...input,
    source: 'ksef_enrollment',
    certificateType: 'Authentication',
    subjectIdentifierType: 'certificateSubject',
    verifyCertificateChain: true,
  });
  return credential;
}

async function listXadesCredentials({ environment = '', includeDisabled = true } = {}) {
  const filter = {};
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (!includeDisabled) filter.enabled = true;
  const rows = await KsefXadesCredential.find(filter)
    .sort({ environment: 1, validTo: -1, createdAt: -1 }).lean();
  return rows.map(publicXadesCredential);
}

async function getXadesCredential(credentialId, { includeSecrets = false, requireEnabled = false, requireUsable = false } = {}) {
  const id = clean(credentialId, 64);
  if (!id) throw appError('ksef_xades_credential_id_required');
  let query = KsefXadesCredential.findOne({ credentialId: id });
  if (includeSecrets) query = query.select('+certificateBase64 +privateKeyEncrypted +privateKeyFingerprint');
  const credential = await query;
  if (!credential) throw appError('ksef_xades_credential_not_found');
  if (requireEnabled && credential.enabled !== true) throw appError('ksef_xades_credential_disabled');
  if (requireUsable) {
    if (credential.revokedAt) throw appError('ksef_xades_credential_revoked');
    assertCertificateCurrentlyValid(credential);
  }
  return credential;
}

async function updateXadesCredential(credentialId, patch = {}) {
  const credential = await getXadesCredential(credentialId);
  const beforeSubjectType = credential.subjectIdentifierType;
  const beforeVerifyChain = credential.verifyCertificateChain;
  const beforeEnabled = credential.enabled;
  if (patch.credentialName !== undefined) credential.credentialName = clean(patch.credentialName, 200);
  if (patch.enabled !== undefined) credential.enabled = patch.enabled === true;
  if (patch.subjectIdentifierType !== undefined) credential.subjectIdentifierType = validateSubjectIdentifierType(patch.subjectIdentifierType);
  if (patch.verifyCertificateChain !== undefined) credential.verifyCertificateChain = credential.environment === 'test' ? patch.verifyCertificateChain !== false : true;
  await credential.save();
  if (beforeSubjectType !== credential.subjectIdentifierType || beforeVerifyChain !== credential.verifyCertificateChain || (beforeEnabled && !credential.enabled)) {
    await KsefXadesAuthSession.deleteMany({ credentialId: credential.credentialId });
  }
  return publicXadesCredential(credential);
}

function decryptXadesPrivateKey(credential) {
  if (!credential?.privateKeyEncrypted || !credential?.credentialId) throw appError('ksef_xades_private_key_invalid');
  return decryptSecret(credential.privateKeyEncrypted, secretScope(credential.credentialId), 'xades-private-key');
}
async function recordXadesCredentialError(credentialId, error) {
  await KsefXadesCredential.updateOne({ credentialId }, {
    $set: { lastConnectionCheckAt: new Date(), lastConnectionError: clean(error?.message || error, 1000) },
  });
}
async function markXadesCredentialRevoked(certificateSerialNumber, environment) {
  const env = normalizeEnvironment(environment);
  const serial = clean(certificateSerialNumber, 128).toUpperCase();
  const credentials = await KsefXadesCredential.find(
    { environment: env, certificateSerialNumber: serial },
    { credentialId: 1, _id: 0 },
  ).lean();
  const credentialIds = credentials.map((row) => clean(row.credentialId, 64)).filter(Boolean);
  await KsefXadesCredential.updateMany(
    { environment: env, certificateSerialNumber: serial },
    { $set: { revokedAt: new Date(), enabled: false } },
  );
  if (credentialIds.length) await KsefXadesAuthSession.deleteMany({ credentialId: { $in: credentialIds } });
}

module.exports = {
  publicXadesCredential,
  importXadesCredential,
  storeIssuedAuthenticationCredential,
  listXadesCredentials,
  getXadesCredential,
  updateXadesCredential,
  decryptXadesPrivateKey,
  recordXadesCredentialError,
  markXadesCredentialRevoked,
};
