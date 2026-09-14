'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');

const AUTH_NS = 'http://ksef.mf.gov.pl/auth/token/2.1';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';
const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';

function compactBase64(value) { return String(value || '').replace(/\s+/g, ''); }
function xmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}
function xmlAttr(value) {
  return xmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;');
}
function sha256Base64(value) { return crypto.createHash('sha256').update(value).digest('base64'); }

function parseCertificate(value) {
  try {
    const raw = String(value || '').trim();
    let bytes;
    if (raw.includes('-----BEGIN CERTIFICATE-----')) {
      bytes = Buffer.from(raw.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, ''), 'base64');
    } else {
      bytes = Buffer.from(compactBase64(raw), 'base64');
    }
    if (!bytes.length) throw new Error('empty certificate');
    return new crypto.X509Certificate(bytes);
  } catch (_) {
    throw appError('ksef_xades_certificate_invalid');
  }
}

function parsePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw appError('ksef_xades_private_key_required');
  try {
    if (raw.includes('-----BEGIN')) return crypto.createPrivateKey(raw);
    const bytes = Buffer.from(compactBase64(raw), 'base64');
    if (!bytes.length) throw new Error('empty private key');
    try { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' }); }
    catch (_) {
      try { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs1' }); }
      catch (_) { return crypto.createPrivateKey({ key: bytes, format: 'der', type: 'sec1' }); }
    }
  } catch (_) {
    throw appError('ksef_xades_private_key_invalid');
  }
}

function validateKeyAlgorithm(privateKey) {
  const type = String(privateKey?.asymmetricKeyType || '');
  const details = privateKey?.asymmetricKeyDetails || {};
  if (type === 'rsa') {
    const modulusLength = Number(details.modulusLength || 0);
    if (modulusLength < 2048) throw appError('ksef_xades_private_key_algorithm_invalid');
    return { keyAlgorithm: 'rsa', keyDetails: { modulusLength }, signatureMethod: RSA_SHA256 };
  }
  if (type === 'ec') {
    const namedCurve = String(details.namedCurve || '');
    const allowed = ['prime256v1', 'P-256', 'secp256r1', 'secp384r1', 'P-384', 'secp521r1', 'P-521'];
    if (!allowed.includes(namedCurve)) throw appError('ksef_xades_private_key_algorithm_invalid');
    return { keyAlgorithm: 'ec', keyDetails: { namedCurve }, signatureMethod: ECDSA_SHA256 };
  }
  throw appError('ksef_xades_private_key_algorithm_invalid');
}

function assertCertificateMatchesPrivateKey(certificate, privateKey) {
  try {
    const a = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const b = certificate.publicKey.export({ format: 'der', type: 'spki' });
    if (!Buffer.from(a).equals(Buffer.from(b))) throw new Error('key mismatch');
  } catch (_) {
    throw appError('ksef_xades_certificate_key_mismatch');
  }
}

function certificateDates(certificate) {
  const validFrom = certificate.validFromDate instanceof Date ? certificate.validFromDate : new Date(certificate.validFrom);
  const validTo = certificate.validToDate instanceof Date ? certificate.validToDate : new Date(certificate.validTo);
  if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validTo.getTime()) || validTo <= validFrom) {
    throw appError('ksef_xades_certificate_invalid');
  }
  return { validFrom, validTo };
}

function assertCertificateCurrentlyValid(value, now = new Date()) {
  const validFrom = new Date(value?.validFrom || value?.certificate?.validFrom || 0);
  const validTo = new Date(value?.validTo || value?.certificate?.validTo || 0);
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(validFrom.getTime()) || !Number.isFinite(validTo.getTime()) || at < validFrom || at > validTo) {
    throw appError('ksef_xades_certificate_not_valid_now');
  }
}

function normalizeIssuer(value) {
  return String(value || '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(',');
}
function serialDecimal(certificate) {
  const hex = String(certificate.serialNumber || '').replace(/[^0-9A-Fa-f]/g, '');
  if (!hex) throw appError('ksef_xades_certificate_invalid');
  return BigInt(`0x${hex}`).toString(10);
}
function canonicalPrivateKeyPem(privateKey) { return String(privateKey.export({ format: 'pem', type: 'pkcs8' })); }

function inspectXadesCredential(certificateValue, privateKeyValue) {
  const certificate = parseCertificate(certificateValue);
  const privateKey = parsePrivateKey(privateKeyValue);
  assertCertificateMatchesPrivateKey(certificate, privateKey);
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
    issuerCanonical: normalizeIssuer(certificate.issuer),
    serialDecimal: serialDecimal(certificate),
    ...dates,
    ...key,
  };
}

function validateSubjectIdentifierType(value) {
  const normalized = String(value || 'certificateSubject').trim();
  if (!['certificateSubject', 'certificateFingerprint'].includes(normalized)) throw appError('ksef_xades_subject_identifier_type_invalid');
  return normalized;
}

function buildAuthTokenRequest({ challenge, nip, subjectIdentifierType = 'certificateSubject' } = {}) {
  const c = String(challenge || '').trim();
  const n = String(nip || '').replace(/\D+/g, '');
  const subjectType = validateSubjectIdentifierType(subjectIdentifierType);
  if (!c || !n) throw appError('ksef_xades_auth_request_invalid');
  return `<AuthTokenRequest xmlns="${AUTH_NS}"><Challenge>${xmlText(c)}</Challenge><ContextIdentifier><Nip>${xmlText(n)}</Nip></ContextIdentifier><SubjectIdentifierType>${xmlText(subjectType)}</SubjectIdentifierType></AuthTokenRequest>`;
}

function canonicalSignedProperties({ signingTime, certificateDigest, issuerName, certificateSerialNumber } = {}) {
  return `<xades:SignedProperties xmlns:xades="${XADES_NS}" Id="SignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>${xmlText(signingTime)}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod xmlns:ds="${DS_NS}" Algorithm="${SHA256}"></ds:DigestMethod><ds:DigestValue xmlns:ds="${DS_NS}">${xmlText(certificateDigest)}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName xmlns:ds="${DS_NS}">${xmlText(issuerName)}</ds:X509IssuerName><ds:X509SerialNumber xmlns:ds="${DS_NS}">${xmlText(certificateSerialNumber)}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
}

function canonicalSignedInfo({ signatureMethod, documentDigest, signedPropertiesDigest } = {}) {
  return `<ds:SignedInfo xmlns="${AUTH_NS}" xmlns:ds="${DS_NS}"><ds:CanonicalizationMethod Algorithm="${C14N}"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="${xmlAttr(signatureMethod)}"></ds:SignatureMethod><ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="${ENVELOPED}"></ds:Transform><ds:Transform Algorithm="${EXC_C14N}"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="${SHA256}"></ds:DigestMethod><ds:DigestValue>${xmlText(documentDigest)}</ds:DigestValue></ds:Reference><ds:Reference Type="${SIGNED_PROPERTIES_TYPE}" URI="#SignedProperties"><ds:Transforms><ds:Transform Algorithm="${EXC_C14N}"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="${SHA256}"></ds:DigestMethod><ds:DigestValue>${xmlText(signedPropertiesDigest)}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
}

function buildQualifyingProperties(signedProperties) {
  return `<ds:Object><xades:QualifyingProperties xmlns:xades="${XADES_NS}" Target="#Signature">${signedProperties}</xades:QualifyingProperties></ds:Object>`;
}

function signSignedInfo(signedInfo, privateKey, keyAlgorithm) {
  if (keyAlgorithm === 'rsa') return crypto.sign('sha256', Buffer.from(signedInfo, 'utf8'), privateKey);
  return crypto.sign('sha256', Buffer.from(signedInfo, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

function verifySignedInfo(signedInfo, signature, publicKey, keyAlgorithm) {
  if (keyAlgorithm === 'rsa') return crypto.verify('sha256', Buffer.from(signedInfo, 'utf8'), publicKey, signature);
  return crypto.verify('sha256', Buffer.from(signedInfo, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
}

function signAuthTokenRequest({ challenge, nip, subjectIdentifierType, certificateBase64, privateKey, signingTime = null } = {}) {
  const inspected = inspectXadesCredential(certificateBase64, privateKey);
  assertCertificateCurrentlyValid(inspected);
  const unsignedXml = buildAuthTokenRequest({ challenge, nip, subjectIdentifierType });
  const time = signingTime ? new Date(signingTime) : new Date(Date.now() - 60_000);
  if (!Number.isFinite(time.getTime())) throw appError('ksef_xades_signing_time_invalid');
  const timeIso = time.toISOString();
  const certificateDigest = sha256Base64(inspected.certificate.raw);
  const signedProperties = canonicalSignedProperties({
    signingTime: timeIso,
    certificateDigest,
    issuerName: inspected.issuerCanonical,
    certificateSerialNumber: inspected.serialDecimal,
  });
  const documentDigest = sha256Base64(Buffer.from(unsignedXml, 'utf8'));
  const signedPropertiesDigest = sha256Base64(Buffer.from(signedProperties, 'utf8'));
  const signedInfo = canonicalSignedInfo({ signatureMethod: inspected.signatureMethod, documentDigest, signedPropertiesDigest });
  const signature = signSignedInfo(signedInfo, inspected.privateKey, inspected.keyAlgorithm);
  const certificate = inspected.certificateBase64;
  const signatureXml = `<ds:Signature xmlns:ds="${DS_NS}" Id="Signature">${signedInfo}<ds:SignatureValue>${signature.toString('base64')}</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>${buildQualifyingProperties(signedProperties)}</ds:Signature>`;
  const signedXml = `${unsignedXml.slice(0, -'</AuthTokenRequest>'.length)}${signatureXml}</AuthTokenRequest>`;
  const result = {
    signedXml,
    unsignedXml,
    signedInfo,
    signedProperties,
    signatureBase64: signature.toString('base64'),
    documentDigest,
    signedPropertiesDigest,
    certificateDigest,
    keyAlgorithm: inspected.keyAlgorithm,
    signatureMethod: inspected.signatureMethod,
    signingTime: timeIso,
  };
  if (!verifyGeneratedXades(result, inspected.certificate)) throw appError('ksef_xades_self_verification_failed');
  return result;
}

function verifyGeneratedXades(result, certificateValue) {
  try {
    const certificate = certificateValue instanceof crypto.X509Certificate ? certificateValue : parseCertificate(certificateValue);
    const expectedDocumentDigest = sha256Base64(Buffer.from(String(result.unsignedXml || ''), 'utf8'));
    const expectedPropertiesDigest = sha256Base64(Buffer.from(String(result.signedProperties || ''), 'utf8'));
    if (expectedDocumentDigest !== result.documentDigest || expectedPropertiesDigest !== result.signedPropertiesDigest) return false;
    const keyAlgorithm = String(certificate.publicKey.asymmetricKeyType || '');
    if (!['rsa', 'ec'].includes(keyAlgorithm)) return false;
    return verifySignedInfo(
      String(result.signedInfo || ''),
      Buffer.from(String(result.signatureBase64 || ''), 'base64'),
      certificate.publicKey,
      keyAlgorithm,
    );
  } catch (_) { return false; }
}

module.exports = {
  AUTH_NS,
  DS_NS,
  XADES_NS,
  SIGNED_PROPERTIES_TYPE,
  C14N,
  EXC_C14N,
  ENVELOPED,
  SHA256,
  RSA_SHA256,
  ECDSA_SHA256,
  parseCertificate,
  parsePrivateKey,
  validateKeyAlgorithm,
  assertCertificateMatchesPrivateKey,
  assertCertificateCurrentlyValid,
  inspectXadesCredential,
  validateSubjectIdentifierType,
  buildAuthTokenRequest,
  canonicalSignedProperties,
  canonicalSignedInfo,
  signAuthTokenRequest,
  verifyGeneratedXades,
};
