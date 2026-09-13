'use strict';

const crypto = require('crypto');

function certificateDerToPublicKey(certificateBase64) {
  const cert = new crypto.X509Certificate(Buffer.from(String(certificateBase64 || ''), 'base64'));
  return cert.publicKey;
}
function rsaOaepSha256Encrypt(input, publicKey) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, buffer).toString('base64');
}
function createSessionEncryption(publicKey) {
  const symmetricKey = crypto.randomBytes(32);
  const initializationVector = crypto.randomBytes(16);
  return {
    symmetricKey,
    initializationVector,
    encryptedSymmetricKey: rsaOaepSha256Encrypt(symmetricKey, publicKey),
    initializationVectorBase64: initializationVector.toString('base64'),
  };
}
function encryptInvoiceXml(xml, symmetricKey, initializationVector) {
  const plaintext = Buffer.from(String(xml), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', symmetricKey, initializationVector);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    plaintext,
    encrypted,
    invoiceHash: crypto.createHash('sha256').update(plaintext).digest('base64'),
    invoiceHashHex: crypto.createHash('sha256').update(plaintext).digest('hex'),
    encryptedInvoiceHash: crypto.createHash('sha256').update(encrypted).digest('base64'),
    invoiceSize: plaintext.length,
    encryptedInvoiceSize: encrypted.length,
    encryptedInvoiceContent: encrypted.toString('base64'),
  };
}
module.exports = { certificateDerToPublicKey, rsaOaepSha256Encrypt, createSessionEncryption, encryptInvoiceXml };
