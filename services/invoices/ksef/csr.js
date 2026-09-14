'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');

const DN_FIELDS = [
  ['commonName', '2.5.4.3'],
  ['surname', '2.5.4.4'],
  ['organizationName', '2.5.4.10'],
  ['organizationIdentifier', '2.5.4.97'],
  ['countryName', '2.5.4.6'],
  ['serialNumber', '2.5.4.5'],
  ['uniqueIdentifier', '2.5.4.45'],
  ['givenName', '2.5.4.42'],
];

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n >>>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, value) {
  const body = Buffer.from(value || []);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
function seq(...items) { return tlv(0x30, Buffer.concat(items.map(Buffer.from))); }
function set(...items) { return tlv(0x31, Buffer.concat(items.map(Buffer.from))); }
function utf8(value) { return tlv(0x0c, Buffer.from(String(value), 'utf8')); }
function printable(value) { return tlv(0x13, Buffer.from(String(value), 'ascii')); }
function nullValue() { return Buffer.from([0x05, 0x00]); }
function bitString(value) { return tlv(0x03, Buffer.concat([Buffer.from([0x00]), Buffer.from(value)])); }
function integerZero() { return Buffer.from([0x02, 0x01, 0x00]); }
function context0Empty() { return Buffer.from([0xa0, 0x00]); }

function oidPart(value) {
  let n = BigInt(value);
  const out = [Number(n & 0x7fn)];
  n >>= 7n;
  while (n > 0n) { out.unshift(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  return out;
}
function oid(value) {
  const parts = String(value).split('.').map((part) => BigInt(part));
  if (parts.length < 2) throw new Error('OID invalid');
  const bytes = [Number(parts[0] * 40n + parts[1])];
  for (let i = 2; i < parts.length; i += 1) bytes.push(...oidPart(parts[i]));
  return tlv(0x06, Buffer.from(bytes));
}

function normalizeEnrollmentData(value = {}) {
  const out = {};
  for (const [field] of DN_FIELDS) {
    const raw = value[field];
    if (field === 'givenName') {
      const values = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
      out[field] = values.map((item) => String(item)).filter((item) => item.length > 0);
    } else if (raw !== undefined && raw !== null && String(raw).length > 0) {
      out[field] = String(raw);
    }
  }
  if (!out.commonName || !out.countryName) throw appError('ksef_certificate_enrollment_data_invalid');
  return out;
}

function attribute(oidValue, value, field) {
  const stringValue = field === 'countryName' ? printable(value) : utf8(value);
  return set(seq(oid(oidValue), stringValue));
}

function buildSubject(enrollmentData) {
  const normalized = normalizeEnrollmentData(enrollmentData);
  const attrs = [];
  for (const [field, oidValue] of DN_FIELDS) {
    const raw = normalized[field];
    const values = Array.isArray(raw) ? raw : (raw === undefined ? [] : [raw]);
    for (const value of values) attrs.push(attribute(oidValue, value, field));
  }
  return { der: seq(...attrs), normalized };
}

function generateKeyPair(keyAlgorithm) {
  const algorithm = String(keyAlgorithm || 'ec').toLowerCase();
  if (algorithm === 'ec') {
    return { algorithm: 'ec', ...crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) };
  }
  if (algorithm === 'rsa') {
    return { algorithm: 'rsa', ...crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 }) };
  }
  throw appError('ksef_certificate_csr_key_algorithm_invalid');
}

function signatureAlgorithmIdentifier(algorithm) {
  if (algorithm === 'ec') return seq(oid('1.2.840.10045.4.3.2'));
  return seq(oid('1.2.840.113549.1.1.11'), nullValue());
}

function signCertificationRequestInfo(cri, privateKey, algorithm) {
  if (algorithm === 'ec') return crypto.sign('sha256', cri, { key: privateKey, dsaEncoding: 'der' });
  return crypto.sign('sha256', cri, privateKey);
}

function verifyCertificationRequestInfo(cri, signature, publicKey, algorithm) {
  if (algorithm === 'ec') return crypto.verify('sha256', cri, { key: publicKey, dsaEncoding: 'der' }, signature);
  return crypto.verify('sha256', cri, publicKey, signature);
}

function generateCertificateSigningRequest(enrollmentData, { keyAlgorithm = 'ec' } = {}) {
  const subject = buildSubject(enrollmentData);
  const pair = generateKeyPair(keyAlgorithm);
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const cri = seq(integerZero(), subject.der, spki, context0Empty());
  const signature = signCertificationRequestInfo(cri, pair.privateKey, pair.algorithm);
  if (!verifyCertificationRequestInfo(cri, signature, pair.publicKey, pair.algorithm)) throw appError('ksef_certificate_csr_self_verification_failed');
  const csrDer = seq(cri, signatureAlgorithmIdentifier(pair.algorithm), bitString(signature));
  const privateKeyDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const privateKeyPem = String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return {
    csrBase64: csrDer.toString('base64'),
    csrSha256Hex: crypto.createHash('sha256').update(csrDer).digest('hex'),
    privateKeyBase64: Buffer.from(privateKeyDer).toString('base64'),
    privateKeyPem,
    keyAlgorithm: pair.algorithm,
    enrollmentData: subject.normalized,
    _test: { cri, signature, publicKey: pair.publicKey },
  };
}

function verifyGeneratedCsr(result) {
  try {
    return verifyCertificationRequestInfo(result?._test?.cri, result?._test?.signature, result?._test?.publicKey, result?.keyAlgorithm);
  } catch (_) { return false; }
}

module.exports = {
  DN_FIELDS,
  normalizeEnrollmentData,
  buildSubject,
  generateCertificateSigningRequest,
  verifyGeneratedCsr,
};
