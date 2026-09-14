'use strict';

const { appError } = require('../../../utils/errors');
const { KSEF_SCHEMA, PUBLIC_KEY_USAGE } = require('./config');
const { ksefRequest } = require('./http');
const { getPublicKey, invalidatePublicKeys } = require('./publicKeys');
const { createSessionEncryption, encryptInvoiceXml } = require('./crypto');
const { isRotatedKeyError } = require('./auth');
const { buildSessionInvoicesRequest } = require('./reconciliationPolicy');

async function openOnlineSession(environment, accessToken, { forceKeys = false } = {}) {
  const key = await getPublicKey(environment, PUBLIC_KEY_USAGE.SESSION, { force: forceKeys });
  const encryption = createSessionEncryption(key.publicKey);
  const response = await ksefRequest(environment, '/sessions/online', {
    method: 'POST', token: accessToken,
    body: {
      formCode: KSEF_SCHEMA,
      encryption: {
        encryptedSymmetricKey: encryption.encryptedSymmetricKey,
        initializationVector: encryption.initializationVectorBase64,
        publicKeyId: key.publicKeyId,
      },
    },
  });
  if (!response.body?.referenceNumber) throw appError('ksef_session_response_invalid');
  return {
    sessionReferenceNumber: response.body.referenceNumber,
    validUntil: response.body.validUntil || null,
    publicKeyId: key.publicKeyId,
    symmetricKey: encryption.symmetricKey,
    initializationVector: encryption.initializationVector,
  };
}

async function openOnlineSessionWithKeyRecovery(environment, accessToken) {
  try { return await openOnlineSession(environment, accessToken); }
  catch (error) {
    if (!isRotatedKeyError(error)) throw error;
    invalidatePublicKeys(environment);
    return openOnlineSession(environment, accessToken, { forceKeys: true });
  }
}

async function sendInvoice(environment, accessToken, session, xml, { offlineMode = false, hashOfCorrectedInvoice = '' } = {}) {
  const encrypted = encryptInvoiceXml(xml, session.symmetricKey, session.initializationVector);
  const response = await ksefRequest(environment, `/sessions/online/${encodeURIComponent(session.sessionReferenceNumber)}/invoices`, {
    method: 'POST', token: accessToken,
    body: {
      invoiceHash: encrypted.invoiceHash,
      invoiceSize: encrypted.invoiceSize,
      encryptedInvoiceHash: encrypted.encryptedInvoiceHash,
      encryptedInvoiceSize: encrypted.encryptedInvoiceSize,
      encryptedInvoiceContent: encrypted.encryptedInvoiceContent,
      offlineMode: offlineMode === true,
      ...(hashOfCorrectedInvoice ? { hashOfCorrectedInvoice: String(hashOfCorrectedInvoice) } : {}),
    },
  });
  if (!response.body?.referenceNumber) throw appError('ksef_send_response_invalid');
  return { invoiceReferenceNumber: response.body.referenceNumber, encrypted };
}

async function closeOnlineSession(environment, accessToken, sessionReferenceNumber) {
  await ksefRequest(environment, `/sessions/online/${encodeURIComponent(sessionReferenceNumber)}/close`, { method: 'POST', token: accessToken });
  return { closed: true };
}

async function getSessionStatus(environment, accessToken, sessionReferenceNumber) {
  const response = await ksefRequest(environment, `/sessions/${encodeURIComponent(sessionReferenceNumber)}`, { token: accessToken });
  return response.body;
}

async function listSessionInvoices(environment, accessToken, sessionReferenceNumber, { maxPages = 10 } = {}) {
  const invoices = [];
  let continuationToken = '';
  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    const request = buildSessionInvoicesRequest(sessionReferenceNumber, continuationToken);
    const response = await ksefRequest(
      environment,
      request.path,
      { token: accessToken, headers: request.headers },
    );
    const pageInvoices = Array.isArray(response.body?.invoices) ? response.body.invoices : [];
    invoices.push(...pageInvoices);
    continuationToken = String(response.body?.continuationToken || '').trim();
    if (!continuationToken) return invoices;
  }
  throw appError('ksef_session_invoice_list_truncated');
}

async function getInvoiceStatus(environment, accessToken, sessionReferenceNumber, invoiceReferenceNumber) {
  const response = await ksefRequest(environment, `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/${encodeURIComponent(invoiceReferenceNumber)}`, { token: accessToken });
  return response.body;
}

async function getInvoiceUpo(environment, accessToken, sessionReferenceNumber, invoiceReferenceNumber) {
  const response = await ksefRequest(
    environment,
    `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/${encodeURIComponent(invoiceReferenceNumber)}/upo`,
    { token: accessToken, responseType: 'buffer', accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
  );
  const content = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '');
  if (!content.length) throw appError('ksef_upo_response_invalid');
  return {
    content,
    providerHashBase64: String(response.headers.get('x-ms-meta-hash') || '').trim(),
  };
}

module.exports = {
  openOnlineSessionWithKeyRecovery,
  sendInvoice,
  closeOnlineSession,
  getSessionStatus,
  listSessionInvoices,
  getInvoiceStatus,
  getInvoiceUpo,
};
