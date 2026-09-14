'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');
const { getEnvironment } = require('./config');
const { parsePrivateKey, validateKeyAlgorithm } = require('./offlineCertificateCrypto');

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function invoiceHashBase64Url(hashBase64) {
  try {
    const bytes = Buffer.from(String(hashBase64 || ''), 'base64');
    if (bytes.length !== 32) throw new Error('not sha256');
    return base64Url(bytes);
  } catch (_) {
    throw appError('ksef_offline_invoice_hash_invalid');
  }
}

function issueDateForQr(issueDate) {
  const value = String(issueDate || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw appError('ksef_offline_issue_date_invalid');
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function qrBaseUrl(environment) {
  const env = getEnvironment(environment);
  if (!env.qrBaseUrl) throw appError('ksef_environment_invalid');
  return env.qrBaseUrl.replace(/\/$/, '');
}

function buildInvoiceVerificationUrl({ environment, sellerNip, issueDate, invoiceHashBase64 }) {
  const nip = String(sellerNip || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(nip)) throw appError('ksef_legal_entity_nip_required');
  return `${qrBaseUrl(environment)}/invoice/${nip}/${issueDateForQr(issueDate)}/${invoiceHashBase64Url(invoiceHashBase64)}`;
}

function signCertificateVerificationPath(pathToSign, privateKeyValue) {
  const privateKey = parsePrivateKey(privateKeyValue);
  const { keyAlgorithm } = validateKeyAlgorithm(privateKey);
  const bytes = Buffer.from(String(pathToSign || ''), 'utf8');
  let signature;
  if (keyAlgorithm === 'rsa') {
    signature = crypto.sign('sha256', bytes, {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
  } else {
    signature = crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  }
  return base64Url(signature);
}

function buildCertificateVerificationUrl({
  environment,
  contextIdentifierType = 'Nip',
  contextIdentifierValue,
  sellerNip,
  certificateSerialNumber,
  invoiceHashBase64,
  privateKey,
}) {
  const allowedTypes = new Set(['Nip', 'InternalId', 'NipVatUe', 'PeppolId']);
  const contextType = String(contextIdentifierType || '').trim();
  if (!allowedTypes.has(contextType)) throw appError('ksef_offline_context_identifier_invalid');
  const contextValue = String(contextIdentifierValue || '').trim();
  if (!contextValue || contextValue.includes('/')) throw appError('ksef_offline_context_identifier_invalid');
  const nip = String(sellerNip || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(nip)) throw appError('ksef_legal_entity_nip_required');
  const serial = String(certificateSerialNumber || '').trim().toUpperCase();
  if (!serial || serial.includes('/')) throw appError('ksef_offline_certificate_invalid');
  const hash = invoiceHashBase64Url(invoiceHashBase64);
  const base = qrBaseUrl(environment);
  const unsignedUrl = `${base}/certificate/${contextType}/${encodeURIComponent(contextValue)}/${nip}/${encodeURIComponent(serial)}/${hash}`;
  const pathToSign = unsignedUrl.replace(/^https:\/\//, '');
  const signature = signCertificateVerificationPath(pathToSign, privateKey);
  return `${unsignedUrl}/${signature}`;
}

module.exports = {
  base64Url,
  invoiceHashBase64Url,
  issueDateForQr,
  qrBaseUrl,
  buildInvoiceVerificationUrl,
  signCertificateVerificationPath,
  buildCertificateVerificationUrl,
};
