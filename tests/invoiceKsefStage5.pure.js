'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const {
  invoiceHashBase64Url,
  issueDateForQr,
  qrBaseUrl,
  buildInvoiceVerificationUrl,
  buildCertificateVerificationUrl,
} = require('../services/invoices/ksef/offlineQr');
const {
  parsePrivateKey,
  validateKeyAlgorithm,
  extractKeyUsageBitsFromDer,
  assertOfflineCertificateUsage,
} = require('../services/invoices/ksef/offlineCertificateCrypto');

function codeOf(fn) {
  try { fn(); }
  catch (error) { return error?.code || ''; }
  return '';
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

async function run() {
  const invoiceBytes = Buffer.from('<Faktura>stage5-offline</Faktura>', 'utf8');
  const invoiceHashBase64 = crypto.createHash('sha256').update(invoiceBytes).digest('base64');
  const invoiceHashUrl = crypto.createHash('sha256').update(invoiceBytes).digest('base64url');

  assert.equal(invoiceHashBase64Url(invoiceHashBase64), invoiceHashUrl);
  assert.equal(issueDateForQr('2026-02-01'), '01-02-2026');
  assert.equal(qrBaseUrl('test'), 'https://qr-test.ksef.mf.gov.pl');
  assert.equal(qrBaseUrl('demo'), 'https://qr-demo.ksef.mf.gov.pl');
  assert.equal(qrBaseUrl('prod'), 'https://qr.ksef.mf.gov.pl');
  assert.equal(
    buildInvoiceVerificationUrl({
      environment: 'test',
      sellerNip: '1111111111',
      issueDate: '2026-02-01',
      invoiceHashBase64,
    }),
    `https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/${invoiceHashUrl}`,
  );

  assert.equal(codeOf(() => issueDateForQr('01-02-2026')), 'ksef_offline_issue_date_invalid');
  assert.equal(codeOf(() => invoiceHashBase64Url(Buffer.alloc(31).toString('base64'))), 'ksef_offline_invoice_hash_invalid');

  // Minimal DER fragments containing the X.509 Key Usage extension.
  const offlineUsageDer = Buffer.from([0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x06, 0x40]);
  const authUsageDer = Buffer.from([0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x07, 0x80]);
  assert.deepEqual(extractKeyUsageBitsFromDer(offlineUsageDer), {
    digitalSignature: false,
    contentCommitment: true,
    firstUsageByte: 0x40,
  });
  assert.equal(assertOfflineCertificateUsage({ raw: offlineUsageDer }).contentCommitment, true);
  assert.equal(codeOf(() => assertOfflineCertificateUsage({ raw: authUsageDer })), 'ksef_offline_certificate_usage_invalid');

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.deepEqual(validateKeyAlgorithm(rsa.privateKey), { keyAlgorithm: 'rsa', keyDetails: { modulusLength: 2048 } });
  const rsaUrl = buildCertificateVerificationUrl({
    environment: 'test',
    contextIdentifierType: 'Nip',
    contextIdentifierValue: '1111111111',
    sellerNip: '1111111111',
    certificateSerialNumber: '01F20A5D352AE590',
    invoiceHashBase64,
    privateKey: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  });
  const rsaParts = rsaUrl.split('/');
  const rsaSignature = decodeBase64Url(rsaParts.pop());
  const rsaUnsignedUrl = rsaParts.join('/');
  const rsaPath = rsaUnsignedUrl.replace(/^https:\/\//, '');
  assert.equal(rsaUnsignedUrl, `https://qr-test.ksef.mf.gov.pl/certificate/Nip/1111111111/1111111111/01F20A5D352AE590/${invoiceHashUrl}`);
  assert.equal(crypto.verify('sha256', Buffer.from(rsaPath, 'utf8'), {
    key: rsa.publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, rsaSignature), true);

  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecMeta = validateKeyAlgorithm(ec.privateKey);
  assert.equal(ecMeta.keyAlgorithm, 'ec');
  const ecSec1Base64 = ec.privateKey.export({ format: 'der', type: 'sec1' }).toString('base64');
  assert.equal(validateKeyAlgorithm(parsePrivateKey(ecSec1Base64)).keyAlgorithm, 'ec');
  assert(['prime256v1', 'P-256', 'secp256r1'].includes(ecMeta.keyDetails.namedCurve));
  const ecUrl = buildCertificateVerificationUrl({
    environment: 'demo',
    contextIdentifierType: 'Nip',
    contextIdentifierValue: '1111111111',
    sellerNip: '1111111111',
    certificateSerialNumber: 'AA01',
    invoiceHashBase64,
    privateKey: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  });
  const ecParts = ecUrl.split('/');
  const ecSignature = decodeBase64Url(ecParts.pop());
  const ecPath = ecParts.join('/').replace(/^https:\/\//, '');
  assert.equal(ecSignature.length, 64); // IEEE P1363 R || S for P-256.
  assert.equal(crypto.verify('sha256', Buffer.from(ecPath, 'utf8'), {
    key: ec.publicKey,
    dsaEncoding: 'ieee-p1363',
  }, ecSignature), true);

  const weakRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.equal(codeOf(() => validateKeyAlgorithm(weakRsa.privateKey)), 'ksef_offline_private_key_algorithm_invalid');
  const wrongCurve = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.equal(codeOf(() => validateKeyAlgorithm(wrongCurve.privateKey)), 'ksef_offline_private_key_algorithm_invalid');


  console.log('Invoice KSeF Stage 5A pure offline contract passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
