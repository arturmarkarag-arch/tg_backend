'use strict';

const crypto = require('crypto');
const KsefCertificateEnrollment = require('../../../models/KsefCertificateEnrollment');
const { appError } = require('../../../utils/errors');
const { ksefRequest } = require('./http');
const { encryptSecret, decryptSecret, fingerprint } = require('./secretStore');
const { getXadesAccessToken } = require('./xadesAuth');
const { generateCertificateSigningRequest, normalizeEnrollmentData } = require('./csr');
const { storeIssuedAuthenticationCredential, markXadesCredentialRevoked } = require('./xadesCredentials');
const { storeIssuedOfflineCertificate, markOfflineCertificateRevoked } = require('./offlineCertificates');

const CERT_NAME_RE = /^[a-zA-Z0-9_\- ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]{5,100}$/u;
const SERIAL_RE = /^[0-9A-F]{16}$/;
const AMBIGUOUS_CODES = new Set(['ksef_api_timeout', 'ksef_api_unavailable']);
function isAmbiguousPostError(error) {
  if (AMBIGUOUS_CODES.has(error?.code)) return true;
  return error?.code === 'ksef_api_error' && Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) >= 500;
}
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function secretScope(enrollmentId) { return `cert-enroll-${clean(enrollmentId, 48)}`; }
function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function publicEnrollment(value) {
  const row = typeof value?.toObject === 'function' ? value.toObject() : (value || {});
  return {
    enrollmentId: clean(row.enrollmentId, 64),
    xadesCredentialId: clean(row.xadesCredentialId, 64),
    legalEntityId: row.legalEntityId ? String(row.legalEntityId) : '',
    environment: clean(row.environment, 20),
    certificateName: clean(row.certificateName, 100),
    certificateType: row.certificateType || '',
    keyAlgorithm: row.keyAlgorithm || '',
    validFrom: row.validFrom || null,
    state: row.state || '',
    enrollmentDataHash: clean(row.enrollmentDataHash, 128),
    csrSha256Hex: clean(row.csrSha256Hex, 128),
    referenceNumber: clean(row.referenceNumber, 200),
    requestDate: row.requestDate || null,
    providerStatusCode: row.providerStatusCode ?? null,
    providerStatusDescription: clean(row.providerStatusDescription, 1000),
    certificateSerialNumber: clean(row.certificateSerialNumber, 128),
    issuedCredentialId: clean(row.issuedCredentialId, 64),
    issuedOfflineCertificateId: clean(row.issuedOfflineCertificateId, 64),
    lastCheckedAt: row.lastCheckedAt || null,
    lastErrorCode: clean(row.lastErrorCode, 100),
    lastErrorMessage: clean(row.lastErrorMessage, 1000),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeCertificateName(value) {
  const name = clean(value, 100);
  if (!CERT_NAME_RE.test(name)) throw appError('ksef_certificate_name_invalid');
  return name;
}
function normalizeCertificateType(value) {
  const type = clean(value, 40);
  if (!['Authentication', 'Offline'].includes(type)) throw appError('ksef_certificate_type_invalid');
  return type;
}
function normalizeKeyAlgorithm(value) {
  const algorithm = clean(value || 'ec', 20).toLowerCase();
  if (!['ec', 'rsa'].includes(algorithm)) throw appError('ksef_certificate_csr_key_algorithm_invalid');
  return algorithm;
}
function normalizeValidFrom(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw appError('ksef_certificate_valid_from_invalid');
  return date;
}

async function listCertificateEnrollments({ xadesCredentialId = '', state = '' } = {}) {
  const filter = {};
  if (xadesCredentialId) filter.xadesCredentialId = clean(xadesCredentialId, 64);
  if (state) filter.state = clean(state, 40);
  const rows = await KsefCertificateEnrollment.find(filter).sort({ createdAt: -1 }).lean();
  return rows.map(publicEnrollment);
}

async function getCertificateEnrollment(enrollmentId, { includeSecret = false } = {}) {
  const id = clean(enrollmentId, 64);
  if (!id) throw appError('ksef_certificate_enrollment_id_required');
  let query = KsefCertificateEnrollment.findOne({ enrollmentId: id });
  if (includeSecret) query = query.select('+csrBase64 +privateKeyEncrypted +privateKeyFingerprint');
  const enrollment = await query;
  if (!enrollment) throw appError('ksef_certificate_enrollment_not_found');
  return enrollment;
}

function decryptEnrollmentPrivateKey(enrollment) {
  if (!enrollment?.privateKeyEncrypted) throw appError('ksef_certificate_private_key_missing');
  return decryptSecret(enrollment.privateKeyEncrypted, secretScope(enrollment.enrollmentId), 'certificate-private-key');
}

async function getCertificateLimits({ xadesCredentialId, legalEntityId } = {}) {
  const auth = await getXadesAccessToken(xadesCredentialId, legalEntityId);
  const response = await ksefRequest(auth.credential.environment, '/certificates/limits', { token: auth.accessToken });
  return response.body || {};
}

async function createCertificateEnrollment({
  xadesCredentialId,
  legalEntityId,
  certificateName,
  certificateType,
  keyAlgorithm = 'ec',
  validFrom = null,
} = {}) {
  const name = normalizeCertificateName(certificateName);
  const type = normalizeCertificateType(certificateType);
  const algorithm = normalizeKeyAlgorithm(keyAlgorithm);
  const from = normalizeValidFrom(validFrom);
  const auth = await getXadesAccessToken(xadesCredentialId, legalEntityId);
  const limitsResponse = await ksefRequest(auth.credential.environment, '/certificates/limits', { token: auth.accessToken });
  if (limitsResponse.body?.canRequest === false) throw appError('ksef_certificate_limit_reached');
  const dataResponse = await ksefRequest(auth.credential.environment, '/certificates/enrollments/data', { token: auth.accessToken });
  const enrollmentData = normalizeEnrollmentData(dataResponse.body || {});
  const csr = generateCertificateSigningRequest(enrollmentData, { keyAlgorithm: algorithm });
  const enrollmentId = crypto.randomUUID();
  const enrollment = new KsefCertificateEnrollment({
    enrollmentId,
    xadesCredentialId: auth.credential.credentialId,
    legalEntityId: auth.entity._id,
    environment: auth.credential.environment,
    certificateName: name,
    certificateType: type,
    keyAlgorithm: algorithm,
    validFrom: from,
    state: 'prepared',
    enrollmentDataHash: sha256Hex(Buffer.from(JSON.stringify(enrollmentData), 'utf8')),
    csrSha256Hex: csr.csrSha256Hex,
    csrBase64: csr.csrBase64,
    privateKeyEncrypted: encryptSecret(csr.privateKeyPem, secretScope(enrollmentId), 'certificate-private-key'),
    privateKeyFingerprint: fingerprint(csr.privateKeyPem),
  });
  await enrollment.save();

  const requestBody = { certificateName: name, certificateType: type, csr: csr.csrBase64 };
  if (from) requestBody.validFrom = from.toISOString();
  try {
    const submitted = await ksefRequest(auth.credential.environment, '/certificates/enrollments', {
      method: 'POST', token: auth.accessToken, body: requestBody,
    });
    const referenceNumber = clean(submitted.body?.referenceNumber, 200);
    if (!referenceNumber) throw appError('ksef_certificate_enrollment_response_invalid');
    enrollment.referenceNumber = referenceNumber;
    enrollment.requestDate = submitted.body?.timestamp ? new Date(submitted.body.timestamp) : new Date();
    enrollment.state = 'submitted';
    enrollment.lastErrorCode = '';
    enrollment.lastErrorMessage = '';
    await enrollment.save();
    return publicEnrollment(enrollment);
  } catch (error) {
    enrollment.lastErrorCode = clean(error?.code || 'ksef_certificate_enrollment_submit_failed', 100);
    enrollment.lastErrorMessage = clean(error?.message || error, 1000);
    if (isAmbiguousPostError(error)) {
      enrollment.state = 'ambiguous_submit';
      await enrollment.save();
      throw appError('ksef_certificate_enrollment_ambiguous', { enrollmentId });
    }
    enrollment.state = 'failed';
    await enrollment.save();
    throw error;
  }
}

async function materializeIssuedCertificate(enrollment, accessToken) {
  const serial = clean(enrollment.certificateSerialNumber, 128).toUpperCase();
  if (!SERIAL_RE.test(serial)) throw appError('ksef_certificate_serial_invalid');
  const response = await ksefRequest(enrollment.environment, '/certificates/retrieve', {
    method: 'POST', token: accessToken, body: { certificateSerialNumbers: [serial] },
  });
  const items = Array.isArray(response.body?.certificates) ? response.body.certificates : [];
  const matching = items.filter((item) => clean(item?.certificateSerialNumber, 128).toUpperCase() === serial);
  if (matching.length !== 1) throw appError('ksef_certificate_retrieve_response_invalid');
  const issued = matching[0];
  const issuedType = clean(issued.certificateType, 40);
  if (issuedType !== enrollment.certificateType || !issued.certificate) throw appError('ksef_certificate_retrieve_response_invalid');
  const privateKey = decryptEnrollmentPrivateKey(enrollment);

  if (issuedType === 'Offline') {
    const stored = await storeIssuedOfflineCertificate({
      legalEntityId: enrollment.legalEntityId,
      environment: enrollment.environment,
      certificateName: clean(issued.certificateName || enrollment.certificateName, 200),
      certificateBase64: issued.certificate,
      privateKey,
      enabled: true,
      isDefault: true,
    });
    enrollment.issuedOfflineCertificateId = stored.certificateId;
  } else {
    const stored = await storeIssuedAuthenticationCredential({
      environment: enrollment.environment,
      credentialName: clean(issued.certificateName || enrollment.certificateName, 200),
      certificateBase64: issued.certificate,
      privateKey,
      enabled: true,
    });
    enrollment.issuedCredentialId = stored.credentialId;
  }
  enrollment.privateKeyEncrypted = undefined;
}

async function reconcileCertificateEnrollment(enrollmentId) {
  const enrollment = await getCertificateEnrollment(enrollmentId, { includeSecret: true });
  if (enrollment.state === 'issued' || enrollment.state === 'failed' || enrollment.state === 'manual_review') return publicEnrollment(enrollment);
  if (enrollment.state === 'ambiguous_submit' || !enrollment.referenceNumber) {
    enrollment.state = 'manual_review';
    enrollment.lastCheckedAt = new Date();
    enrollment.lastErrorCode = 'ksef_certificate_enrollment_ambiguous';
    enrollment.lastErrorMessage = 'Provider POST result is ambiguous and no referenceNumber exists; automatic replay is blocked.';
    await enrollment.save();
    return publicEnrollment(enrollment);
  }
  const auth = await getXadesAccessToken(enrollment.xadesCredentialId, enrollment.legalEntityId);
  try {
    const statusResponse = await ksefRequest(enrollment.environment, `/certificates/enrollments/${encodeURIComponent(enrollment.referenceNumber)}`, {
      token: auth.accessToken,
    });
    const code = Number(statusResponse.body?.status?.code || 0);
    enrollment.providerStatusCode = code || null;
    enrollment.providerStatusDescription = clean(statusResponse.body?.status?.description || statusResponse.body?.status?.details || '', 1000);
    enrollment.requestDate = statusResponse.body?.requestDate ? new Date(statusResponse.body.requestDate) : enrollment.requestDate;
    enrollment.lastCheckedAt = new Date();
    enrollment.lastErrorCode = '';
    enrollment.lastErrorMessage = '';
    if (code === 200) {
      enrollment.certificateSerialNumber = clean(statusResponse.body?.certificateSerialNumber, 128).toUpperCase();
      if (!SERIAL_RE.test(enrollment.certificateSerialNumber)) throw appError('ksef_certificate_serial_invalid');
      await materializeIssuedCertificate(enrollment, auth.accessToken);
      enrollment.state = 'issued';
    } else if (code >= 400) {
      enrollment.state = 'failed';
    } else {
      enrollment.state = 'processing';
    }
    await enrollment.save();
    return publicEnrollment(enrollment);
  } catch (error) {
    enrollment.lastCheckedAt = new Date();
    if (Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) === 410) {
      enrollment.state = 'manual_review';
      enrollment.lastErrorCode = 'ksef_certificate_enrollment_status_expired';
      enrollment.lastErrorMessage = 'KSeF no longer retains this asynchronous enrollment status; automatic completion is fail-closed.';
      await enrollment.save();
      return publicEnrollment(enrollment);
    }
    enrollment.lastErrorCode = clean(error?.code || 'ksef_certificate_enrollment_status_failed', 100);
    enrollment.lastErrorMessage = clean(error?.message || error, 1000);
    await enrollment.save();
    throw error;
  }
}

async function revokeKsefCertificate({ xadesCredentialId, legalEntityId, certificateSerialNumber, revocationReason = 'Unspecified' } = {}) {
  const serial = clean(certificateSerialNumber, 128).toUpperCase();
  if (!SERIAL_RE.test(serial)) throw appError('ksef_certificate_serial_invalid');
  const reason = clean(revocationReason || 'Unspecified', 40);
  if (!['Unspecified', 'Superseded', 'KeyCompromise'].includes(reason)) throw appError('ksef_certificate_revocation_reason_invalid');
  const auth = await getXadesAccessToken(xadesCredentialId, legalEntityId);
  await ksefRequest(auth.credential.environment, `/certificates/${encodeURIComponent(serial)}/revoke`, {
    method: 'POST', token: auth.accessToken, body: { revocationReason: reason },
  });
  await Promise.all([
    markXadesCredentialRevoked(serial, auth.credential.environment),
    markOfflineCertificateRevoked(serial, auth.credential.environment),
  ]);
  return { ok: true, certificateSerialNumber: serial, revocationReason: reason };
}

module.exports = {
  publicEnrollment,
  getCertificateLimits,
  listCertificateEnrollments,
  getCertificateEnrollment,
  createCertificateEnrollment,
  reconcileCertificateEnrollment,
  revokeKsefCertificate,
};
