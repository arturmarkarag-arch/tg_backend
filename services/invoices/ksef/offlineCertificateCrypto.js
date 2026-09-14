'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');

function compactBase64(value) {
  return String(value || '').replace(/\s+/g, '');
}

function parseCertificate(certificateBase64) {
  try {
    const bytes = Buffer.from(compactBase64(certificateBase64), 'base64');
    if (!bytes.length) throw new Error('empty certificate');
    return new crypto.X509Certificate(bytes);
  } catch (_) {
    throw appError('ksef_offline_certificate_invalid');
  }
}

function parsePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw appError('ksef_offline_private_key_required');
  try {
    if (raw.includes('-----BEGIN')) return crypto.createPrivateKey(raw);
    const bytes = Buffer.from(compactBase64(raw), 'base64');
    if (!bytes.length) throw new Error('empty key');
    try { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' }); }
    catch (_) {
      try { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs1' }); }
      catch (_) { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'sec1' }); }
    }
  } catch (_) {
    throw appError('ksef_offline_private_key_invalid');
  }
}

function canonicalPrivateKeyPem(privateKey) {
  return String(privateKey.export({ format: 'pem', type: 'pkcs8' }));
}

function certificateDates(certificate) {
  const validFrom = certificate.validFromDate instanceof Date ? certificate.validFromDate : new Date(certificate.validFrom);
  const validTo = certificate.validToDate instanceof Date ? certificate.validToDate : new Date(certificate.validTo);
  if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validTo.getTime()) || validTo <= validFrom) {
    throw appError('ksef_offline_certificate_invalid');
  }
  return { validFrom, validTo };
}


function readDerLength(buffer, offset) {
  const first = buffer[offset];
  if (first === undefined) throw new Error('DER length missing');
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  if (count < 1 || count > 4 || offset + count >= buffer.length) throw new Error('DER length invalid');
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length * 256) + buffer[offset + 1 + index];
  return { length, bytes: 1 + count };
}

function readDerTlv(buffer, offset) {
  const tag = buffer[offset];
  if (tag === undefined) throw new Error('DER tag missing');
  const parsed = readDerLength(buffer, offset + 1);
  const valueStart = offset + 1 + parsed.bytes;
  const end = valueStart + parsed.length;
  if (end > buffer.length) throw new Error('DER value truncated');
  return { tag, valueStart, end, next: end };
}

function extractKeyUsageBitsFromDer(certificateDer) {
  const bytes = Buffer.from(certificateDer || []);
  // id-ce-keyUsage = 2.5.29.15, encoded as OID 06 03 55 1D 0F.
  const marker = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
  const oidOffset = bytes.indexOf(marker);
  if (oidOffset < 0) throw appError('ksef_offline_certificate_usage_invalid');
  try {
    let offset = oidOffset + marker.length;
    let tlv = readDerTlv(bytes, offset);
    if (tlv.tag === 0x01) { // optional critical BOOLEAN
      offset = tlv.next;
      tlv = readDerTlv(bytes, offset);
    }
    if (tlv.tag !== 0x04) throw new Error('keyUsage extension value missing');
    const extensionValue = bytes.subarray(tlv.valueStart, tlv.end);
    const bitString = readDerTlv(extensionValue, 0);
    if (bitString.tag !== 0x03 || bitString.valueStart >= bitString.end) throw new Error('keyUsage bit string missing');
    const unusedBits = extensionValue[bitString.valueStart];
    const firstUsageByte = extensionValue[bitString.valueStart + 1];
    if (unusedBits > 7 || firstUsageByte === undefined) throw new Error('keyUsage bit string invalid');
    return {
      digitalSignature: (firstUsageByte & 0x80) !== 0,
      contentCommitment: (firstUsageByte & 0x40) !== 0,
      firstUsageByte,
    };
  } catch (_) {
    throw appError('ksef_offline_certificate_usage_invalid');
  }
}

function assertOfflineCertificateUsage(certificate) {
  const usage = extractKeyUsageBitsFromDer(certificate.raw);
  // KSeF Offline cert: Non-Repudiation / Content Commitment (0x40).
  // Authentication cert uses Digital Signature (0x80) and must not be accepted as Offline.
  if (!usage.contentCommitment || usage.digitalSignature) throw appError('ksef_offline_certificate_usage_invalid');
  return usage;
}

function validateKeyAlgorithm(privateKey) {
  const type = String(privateKey.asymmetricKeyType || '');
  const details = privateKey.asymmetricKeyDetails || {};
  if (type === 'rsa') {
    const modulusLength = Number(details.modulusLength || 0);
    if (modulusLength < 2048) throw appError('ksef_offline_private_key_algorithm_invalid');
    return { keyAlgorithm: 'rsa', keyDetails: { modulusLength } };
  }
  if (type === 'ec') {
    const namedCurve = String(details.namedCurve || '');
    if (!['prime256v1', 'P-256', 'secp256r1'].includes(namedCurve)) {
      throw appError('ksef_offline_private_key_algorithm_invalid');
    }
    return { keyAlgorithm: 'ec', keyDetails: { namedCurve } };
  }
  throw appError('ksef_offline_private_key_algorithm_invalid');
}

function assertCertificateMatchesPrivateKey(certificate, privateKey) {
  try {
    const fromPrivate = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const fromCertificate = certificate.publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.from(fromPrivate).equals(Buffer.from(fromCertificate))) throw new Error('mismatch');
  } catch (_) {
    throw appError('ksef_offline_certificate_key_mismatch');
  }
}

function inspectOfflineCertificate(certificateBase64, privateKeyValue) {
  const certificate = parseCertificate(certificateBase64);
  const privateKey = parsePrivateKey(privateKeyValue);
  assertCertificateMatchesPrivateKey(certificate, privateKey);
  const keyUsage = assertOfflineCertificateUsage(certificate);
  const key = validateKeyAlgorithm(privateKey);
  const dates = certificateDates(certificate);
  return {
    certificate,
    privateKey,
    canonicalPrivateKeyPem: canonicalPrivateKeyPem(privateKey),
    certificateBase64: certificate.raw.toString('base64'),
    certificateSerialNumber: String(certificate.serialNumber || '').trim().toUpperCase(),
    certificateSha256Hex: crypto.createHash('sha256').update(certificate.raw).digest('hex'),
    subject: String(certificate.subject || ''),
    issuer: String(certificate.issuer || ''),
    ...dates,
    ...key,
    keyUsage,
  };
}

function assertCertificateCurrentlyValid(certificate, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime()) || at < new Date(certificate.validFrom) || at > new Date(certificate.validTo)) {
    throw appError('ksef_offline_certificate_not_valid_now');
  }
}

module.exports = {
  parseCertificate,
  parsePrivateKey,
  canonicalPrivateKeyPem,
  extractKeyUsageBitsFromDer,
  assertOfflineCertificateUsage,
  validateKeyAlgorithm,
  assertCertificateMatchesPrivateKey,
  inspectOfflineCertificate,
  assertCertificateCurrentlyValid,
};
