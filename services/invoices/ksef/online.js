'use strict';

const { appError } = require('../../../utils/errors');
const { KSEF_SCHEMA, PUBLIC_KEY_USAGE } = require('./config');
const { ksefRequest } = require('./http');
const { getPublicKey, invalidatePublicKeys } = require('./publicKeys');
const { createSessionEncryption, encryptInvoiceXml } = require('./crypto');
const { isRotatedKeyError } = require('./auth');

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

async function sendInvoice(environment, accessToken, session, xml) {
  const encrypted = encryptInvoiceXml(xml, session.symmetricKey, session.initializationVector);
  const response = await ksefRequest(environment, `/sessions/online/${encodeURIComponent(session.sessionReferenceNumber)}/invoices`, {
    method: 'POST', token: accessToken,
    body: {
      invoiceHash: encrypted.invoiceHash,
      invoiceSize: encrypted.invoiceSize,
      encryptedInvoiceHash: encrypted.encryptedInvoiceHash,
      encryptedInvoiceSize: encrypted.encryptedInvoiceSize,
      encryptedInvoiceContent: encrypted.encryptedInvoiceContent,
      offlineMode: false,
    },
  });
  if (!response.body?.referenceNumber) throw appError('ksef_send_response_invalid');
  return { invoiceReferenceNumber: response.body.referenceNumber, encrypted };
}

async function closeOnlineSession(environment, accessToken, sessionReferenceNumber) {
  await ksefRequest(environment, `/sessions/online/${encodeURIComponent(sessionReferenceNumber)}/close`, { method: 'POST', token: accessToken });
  return { closed: true };
}

async function getInvoiceStatus(environment, accessToken, sessionReferenceNumber, invoiceReferenceNumber) {
  const response = await ksefRequest(environment, `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices/${encodeURIComponent(invoiceReferenceNumber)}`, { token: accessToken });
  return response.body;
}

module.exports = { openOnlineSessionWithKeyRecovery, sendInvoice, closeOnlineSession, getInvoiceStatus };
