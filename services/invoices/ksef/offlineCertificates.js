'use strict';

const crypto = require('crypto');
const KsefOfflineCertificate = require('../../../models/KsefOfflineCertificate');
const LegalEntity = require('../../../models/LegalEntity');
const { appError } = require('../../../utils/errors');
const { normalizeEnvironment } = require('./config');
const { encryptSecret, decryptSecret, fingerprint } = require('./secretStore');
const { inspectOfflineCertificate, assertCertificateCurrentlyValid } = require('./offlineCertificateCrypto');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function secretScope(certificateId) { return `offline-cert-${clean(certificateId, 64)}`; }

function publicOfflineCertificate(value) {
  const row = typeof value?.toObject === 'function' ? value.toObject() : (value || {});
  return {
    certificateId: clean(row.certificateId, 64),
    legalEntityId: row.legalEntityId ? String(row.legalEntityId) : '',
    environment: clean(row.environment, 20),
    certificateSerialNumber: clean(row.certificateSerialNumber, 128),
    certificateName: clean(row.certificateName, 200),
    certificateType: row.certificateType || 'Offline',
    source: row.source || 'manual_import',
    enabled: row.enabled === true,
    isDefault: row.isDefault === true,
    certificateSha256Hex: clean(row.certificateSha256Hex, 128),
    keyAlgorithm: row.keyAlgorithm || '',
    keyDetails: row.keyDetails || null,
    keyUsage: row.keyUsage || null,
    subject: row.subject || '',
    issuer: row.issuer || '',
    validFrom: row.validFrom || null,
    validTo: row.validTo || null,
    importedAt: row.importedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    revokedAt: row.revokedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function assertLegalEntityForOffline(legalEntityId) {
  const entity = await LegalEntity.findById(legalEntityId);
  if (!entity) throw appError('legal_entity_not_found');
  if (!entity.isActive) throw appError('legal_entity_inactive');
  if (entity.countryCode !== 'PL' || entity.taxIdType !== 'nip' || !entity.taxId) throw appError('ksef_legal_entity_nip_required');
  return entity;
}

async function makeDefault(certificate) {
  await KsefOfflineCertificate.updateMany(
    {
      legalEntityId: certificate.legalEntityId,
      environment: certificate.environment,
      certificateId: { $ne: certificate.certificateId },
      isDefault: true,
    },
    { $set: { isDefault: false } },
  );
  certificate.isDefault = true;
}

async function importOfflineCertificate({
  legalEntityId,
  environment,
  certificateType,
  certificateName = '',
  certificateBase64,
  privateKey,
  enabled = true,
  isDefault = true,
} = {}) {
  const env = normalizeEnvironment(environment);
  const entity = await assertLegalEntityForOffline(legalEntityId);
  if (String(certificateType || '').trim() !== 'Offline') throw appError('ksef_offline_certificate_type_required');

  const inspected = inspectOfflineCertificate(certificateBase64, privateKey);
  if (!inspected.certificateSerialNumber) throw appError('ksef_offline_certificate_invalid');
  const canonicalPrivateKey = inspected.canonicalPrivateKeyPem;
  const keyFingerprint = fingerprint(canonicalPrivateKey);

  let certificate = await KsefOfflineCertificate.findOne({
    legalEntityId: entity._id,
    environment: env,
    certificateSerialNumber: inspected.certificateSerialNumber,
  }).select('+privateKeyFingerprint');

  if (certificate) {
    if (certificate.certificateSha256Hex !== inspected.certificateSha256Hex || certificate.privateKeyFingerprint !== keyFingerprint) {
      throw appError('ksef_offline_certificate_conflict');
    }
    certificate.certificateName = clean(certificateName || certificate.certificateName, 200);
    certificate.enabled = enabled !== false;
    certificate.validFrom = inspected.validFrom;
    certificate.validTo = inspected.validTo;
    certificate.subject = inspected.subject;
    certificate.issuer = inspected.issuer;
    certificate.keyAlgorithm = inspected.keyAlgorithm;
    certificate.keyDetails = inspected.keyDetails;
    certificate.keyUsage = inspected.keyUsage;
    if (isDefault === true) await makeDefault(certificate);
    if (enabled === false) certificate.isDefault = false;
    await certificate.save();
    return publicOfflineCertificate(certificate);
  }

  const certificateId = crypto.randomUUID();
  certificate = new KsefOfflineCertificate({
    certificateId,
    legalEntityId: entity._id,
    environment: env,
    certificateSerialNumber: inspected.certificateSerialNumber,
    certificateName: clean(certificateName, 200),
    certificateType: 'Offline',
    source: 'manual_import',
    enabled: enabled !== false,
    isDefault: false,
    certificateBase64: inspected.certificateBase64,
    certificateSha256Hex: inspected.certificateSha256Hex,
    privateKeyEncrypted: encryptSecret(canonicalPrivateKey, secretScope(certificateId), 'offline-private-key'),
    privateKeyFingerprint: keyFingerprint,
    keyAlgorithm: inspected.keyAlgorithm,
    keyDetails: inspected.keyDetails,
    keyUsage: inspected.keyUsage,
    subject: inspected.subject,
    issuer: inspected.issuer,
    validFrom: inspected.validFrom,
    validTo: inspected.validTo,
    importedAt: new Date(),
  });
  if (isDefault === true && certificate.enabled) await makeDefault(certificate);
  try {
    await certificate.save();
  } catch (error) {
    if (Number(error?.code) === 11000) throw appError('ksef_offline_certificate_conflict');
    throw error;
  }
  return publicOfflineCertificate(certificate);
}


async function storeIssuedOfflineCertificate({ legalEntityId, environment, certificateName = '', certificateBase64, privateKey, enabled = true, isDefault = true } = {}) {
  const stored = await importOfflineCertificate({
    legalEntityId, environment, certificateType: 'Offline', certificateName, certificateBase64, privateKey, enabled, isDefault,
  });
  await KsefOfflineCertificate.updateOne({ certificateId: stored.certificateId }, { $set: { source: 'ksef_enrollment' } });
  return { ...stored, source: 'ksef_enrollment' };
}

async function listOfflineCertificates({ legalEntityId = '', environment = '', includeDisabled = true } = {}) {
  const filter = {};
  if (legalEntityId) filter.legalEntityId = legalEntityId;
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (!includeDisabled) filter.enabled = true;
  const rows = await KsefOfflineCertificate.find(filter)
    .sort({ legalEntityId: 1, environment: 1, isDefault: -1, validTo: -1, createdAt: -1 })
    .lean();
  return rows.map(publicOfflineCertificate);
}

async function updateOfflineCertificate(certificateId, patch = {}) {
  const id = clean(certificateId, 64);
  if (!id) throw appError('ksef_offline_certificate_id_required');
  const certificate = await KsefOfflineCertificate.findOne({ certificateId: id });
  if (!certificate) throw appError('ksef_offline_certificate_not_found');
  if (patch.certificateName !== undefined) certificate.certificateName = clean(patch.certificateName, 200);
  if (patch.enabled !== undefined) certificate.enabled = patch.enabled === true;
  if (patch.isDefault === true) {
    if (!certificate.enabled) throw appError('ksef_offline_certificate_disabled');
    await makeDefault(certificate);
  } else if (patch.isDefault === false) {
    certificate.isDefault = false;
  }
  if (!certificate.enabled) certificate.isDefault = false;
  await certificate.save();
  return publicOfflineCertificate(certificate);
}

async function getDefaultOfflineCertificate(legalEntityId, environment, { includeSecret = false, requireUsable = true } = {}) {
  const env = normalizeEnvironment(environment);
  let query = KsefOfflineCertificate.findOne({ legalEntityId, environment: env, enabled: true, isDefault: true });
  if (includeSecret) query = query.select('+privateKeyEncrypted');
  const certificate = await query;
  if (!certificate) throw appError('ksef_offline_certificate_not_found');
  if (certificate.certificateType !== 'Offline') throw appError('ksef_offline_certificate_type_required');
  if (requireUsable) assertCertificateCurrentlyValid(certificate);
  return certificate;
}

function decryptOfflinePrivateKey(certificate) {
  if (!certificate?.privateKeyEncrypted || !certificate?.certificateId) throw appError('ksef_offline_private_key_invalid');
  return decryptSecret(certificate.privateKeyEncrypted, secretScope(certificate.certificateId), 'offline-private-key');
}


async function markOfflineCertificateRevoked(certificateSerialNumber, environment) {
  const env = normalizeEnvironment(environment);
  await KsefOfflineCertificate.updateMany(
    { environment: env, certificateSerialNumber: clean(certificateSerialNumber, 128) },
    { $set: { revokedAt: new Date(), enabled: false, isDefault: false } },
  );
}

async function touchOfflineCertificate(certificateId) {
  await KsefOfflineCertificate.updateOne({ certificateId }, { $set: { lastUsedAt: new Date() } });
}

module.exports = {
  publicOfflineCertificate,
  importOfflineCertificate,
  storeIssuedOfflineCertificate,
  listOfflineCertificates,
  updateOfflineCertificate,
  getDefaultOfflineCertificate,
  decryptOfflinePrivateKey,
  touchOfflineCertificate,
  markOfflineCertificateRevoked,
};
