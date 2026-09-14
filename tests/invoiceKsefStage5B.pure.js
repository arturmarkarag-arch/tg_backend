'use strict';

const assert = require('assert');
const {
  AUTH_NS,
  SIGNED_PROPERTIES_TYPE,
  EXC_C14N,
  ENVELOPED,
  ECDSA_SHA256,
  RSA_SHA256,
  signAuthTokenRequest,
  verifyGeneratedXades,
} = require('../services/invoices/ksef/xadesCrypto');
const {
  normalizeEnrollmentData,
  generateCertificateSigningRequest,
  verifyGeneratedCsr,
} = require('../services/invoices/ksef/csr');
const { generateEphemeralCertificate } = require('./helpers/ksefStage5BX509');

const challenge = '20260914-CR-AAAAAAAAAA-BBBBBBBBBB-CC';
const nip = '1111111111';

function xadesFor(kind) {
  const fixture = generateEphemeralCertificate(kind);
  return {
    certificate: fixture.certificate,
    result: signAuthTokenRequest({
      challenge,
      nip,
      subjectIdentifierType: 'certificateSubject',
      certificateBase64: fixture.certificateBase64,
      privateKey: fixture.privateKeyPem,
    }),
  };
}

const rsa = xadesFor('rsa');
assert.equal(rsa.result.keyAlgorithm, 'rsa');
assert.equal(rsa.result.signatureMethod, RSA_SHA256);
assert.equal(verifyGeneratedXades(rsa.result, rsa.certificate), true);
assert(rsa.result.signedXml.includes(`xmlns="${AUTH_NS}"`));
assert(rsa.result.signedXml.includes(`Type="${SIGNED_PROPERTIES_TYPE}" URI="#SignedProperties"`));
assert(rsa.result.signedXml.includes(`Algorithm="${ENVELOPED}"`));
assert(rsa.result.signedXml.includes(`Algorithm="${EXC_C14N}"`));
assert(rsa.result.signedInfo.includes(`xmlns="${AUTH_NS}" xmlns:ds=`), 'inclusive C14N namespace context must be signed');

const ec = xadesFor('ec');
assert.equal(ec.result.keyAlgorithm, 'ec');
assert.equal(ec.result.signatureMethod, ECDSA_SHA256);
assert.equal(Buffer.from(ec.result.signatureBase64, 'base64').length, 64, 'P-256 XMLDSIG ECDSA must be IEEE-P1363 R||S');
assert.equal(verifyGeneratedXades(ec.result, ec.certificate), true);
const tampered = { ...ec.result, unsignedXml: ec.result.unsignedXml.replace(nip, '2222222222') };
assert.equal(verifyGeneratedXades(tampered, ec.certificate), false, 'tampered AuthTokenRequest must fail local verification');

const enrollmentData = normalizeEnrollmentData({
  commonName: 'Jan Kowalski',
  surname: 'Kowalski',
  countryName: 'PL',
  serialNumber: 'PNOPL-12345678901',
  givenName: ['Jan', 'Adam'],
  uniqueIdentifier: 'TEST-123',
});
assert.deepEqual(enrollmentData.givenName, ['Jan', 'Adam']);
for (const keyAlgorithm of ['ec', 'rsa']) {
  const csr = generateCertificateSigningRequest(enrollmentData, { keyAlgorithm });
  assert.equal(csr.keyAlgorithm, keyAlgorithm);
  assert.equal(verifyGeneratedCsr(csr), true);
  assert(Buffer.from(csr.csrBase64, 'base64').length > 100);
  assert(csr.privateKeyPem.includes('BEGIN PRIVATE KEY'));
}

console.log('Invoice KSeF Stage 5B pure XAdES/CSR contract passed');
