'use strict';

const crypto = require('crypto');
const LegalEntity = require('../../../models/LegalEntity');
const KsefXadesAuthSession = require('../../../models/KsefXadesAuthSession');
const KsefXadesCredential = require('../../../models/KsefXadesCredential');
const { appError } = require('../../../utils/errors');
const { ksefRequest } = require('./http');
const { encryptSecret, decryptSecret } = require('./secretStore');
const {
  getXadesCredential,
  decryptXadesPrivateKey,
  recordXadesCredentialError,
} = require('./xadesCredentials');
const { signAuthTokenRequest } = require('./xadesCrypto');

const ACCESS_MARGIN_MS = 60_000;
const AUTH_WAIT_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function validUntil(date, margin = ACCESS_MARGIN_MS) { return date && new Date(date).getTime() - margin > Date.now(); }
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function authSessionId(credentialId, legalEntityId, environment) {
  return crypto.createHash('sha256').update(`${credentialId}|${legalEntityId}|${environment}`, 'utf8').digest('hex');
}

async function resolveLegalEntityForXades(legalEntityId) {
  const entity = await LegalEntity.findById(legalEntityId);
  if (!entity) throw appError('legal_entity_not_found');
  if (!entity.isActive) throw appError('legal_entity_inactive');
  if (entity.countryCode !== 'PL' || entity.taxIdType !== 'nip' || !entity.taxId) throw appError('ksef_legal_entity_nip_required');
  return entity;
}

async function getAuthSession(credential, entity, { includeSecrets = false } = {}) {
  const sessionId = authSessionId(credential.credentialId, String(entity._id), credential.environment);
  let session = await KsefXadesAuthSession.findOne({ sessionId });
  if (!session) {
    try {
      session = await KsefXadesAuthSession.create({
        sessionId,
        credentialId: credential.credentialId,
        legalEntityId: entity._id,
        environment: credential.environment,
      });
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      session = await KsefXadesAuthSession.findOne({ sessionId });
    }
  }
  if (includeSecrets) session = await KsefXadesAuthSession.findOne({ sessionId })
    .select('+accessTokenEncrypted +accessTokenValidUntil +refreshTokenEncrypted +refreshTokenValidUntil');
  return session;
}

function decryptSessionToken(session, kind) {
  const field = kind === 'refresh' ? 'refreshTokenEncrypted' : 'accessTokenEncrypted';
  return session?.[field] ? decryptSecret(session[field], session.sessionId, `xades-${kind}-token`) : '';
}

async function saveSessionTokens(session, { accessToken, accessTokenValidUntil, refreshToken = '', refreshTokenValidUntil = null } = {}) {
  if (!accessToken || !accessTokenValidUntil) throw appError('ksef_auth_response_invalid');
  session.accessTokenEncrypted = encryptSecret(accessToken, session.sessionId, 'xades-access-token');
  session.accessTokenValidUntil = new Date(accessTokenValidUntil);
  if (refreshToken) {
    session.refreshTokenEncrypted = encryptSecret(refreshToken, session.sessionId, 'xades-refresh-token');
    session.refreshTokenValidUntil = refreshTokenValidUntil ? new Date(refreshTokenValidUntil) : null;
  }
  session.lastAuthAt = new Date();
  session.lastError = '';
  await session.save();
}

async function refreshAccessToken(credential, session) {
  if (!validUntil(session.refreshTokenValidUntil, 5_000) || !session.refreshTokenEncrypted) return '';
  const refreshToken = decryptSessionToken(session, 'refresh');
  const response = await ksefRequest(credential.environment, '/auth/token/refresh', { method: 'POST', token: refreshToken });
  const access = response.body?.accessToken;
  if (!access?.token || !access?.validUntil) throw appError('ksef_auth_response_invalid');
  await saveSessionTokens(session, { accessToken: access.token, accessTokenValidUntil: access.validUntil });
  return access.token;
}

async function waitForAuthentication(environment, referenceNumber, authenticationToken) {
  const deadline = Date.now() + AUTH_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await ksefRequest(environment, `/auth/${encodeURIComponent(referenceNumber)}`, { token: authenticationToken });
    const statusCode = Number(response.body?.status?.code || 0);
    if (statusCode === 200) return response.body;
    if (statusCode >= 400) throw appError('ksef_auth_rejected', { providerStatus: response.body?.status || null });
    await sleep(400);
  }
  throw appError('ksef_auth_timeout');
}

async function fullXadesAuthentication(credential, entity, session) {
  const challengeResponse = await ksefRequest(credential.environment, '/auth/challenge', { method: 'POST' });
  const challenge = challengeResponse.body?.challenge;
  if (!challenge) throw appError('ksef_auth_response_invalid');
  const privateKey = decryptXadesPrivateKey(credential);
  const signed = signAuthTokenRequest({
    challenge,
    nip: String(entity.taxId),
    subjectIdentifierType: credential.subjectIdentifierType,
    certificateBase64: credential.certificateBase64,
    privateKey,
  });
  const verifyChain = credential.environment === 'test' ? credential.verifyCertificateChain !== false : true;
  const init = await ksefRequest(
    credential.environment,
    `/auth/xades-signature?verifyCertificateChain=${verifyChain ? 'true' : 'false'}`,
    {
      method: 'POST',
      rawBody: signed.signedXml,
      contentType: 'application/xml; charset=utf-8',
    },
  );
  const referenceNumber = init.body?.referenceNumber;
  const authenticationToken = init.body?.authenticationToken?.token;
  if (!referenceNumber || !authenticationToken) throw appError('ksef_auth_response_invalid');
  await waitForAuthentication(credential.environment, referenceNumber, authenticationToken);
  const redeemed = await ksefRequest(credential.environment, '/auth/token/redeem', { method: 'POST', token: authenticationToken });
  const access = redeemed.body?.accessToken;
  const refresh = redeemed.body?.refreshToken;
  if (!access?.token || !access?.validUntil || !refresh?.token || !refresh?.validUntil) throw appError('ksef_auth_response_invalid');
  await saveSessionTokens(session, {
    accessToken: access.token,
    accessTokenValidUntil: access.validUntil,
    refreshToken: refresh.token,
    refreshTokenValidUntil: refresh.validUntil,
  });
  await KsefXadesCredential.updateOne({ credentialId: credential.credentialId }, {
    $set: { lastAuthAt: new Date(), lastConnectionCheckAt: new Date(), lastConnectionError: '' },
  });
  return { accessToken: access.token, authenticated: true, refreshed: false };
}

async function getXadesAccessToken(credentialId, legalEntityId, { forceReauthenticate = false } = {}) {
  const credential = await getXadesCredential(credentialId, { includeSecrets: true, requireEnabled: true, requireUsable: true });
  const entity = await resolveLegalEntityForXades(legalEntityId);
  let session = await getAuthSession(credential, entity, { includeSecrets: true });
  try {
    if (!forceReauthenticate && validUntil(session.accessTokenValidUntil) && session.accessTokenEncrypted) {
      return { credential, entity, session, accessToken: decryptSessionToken(session, 'access'), authenticated: false, refreshed: false };
    }
    if (!forceReauthenticate) {
      try {
        const accessToken = await refreshAccessToken(credential, session);
        if (accessToken) return { credential, entity, session, accessToken, authenticated: false, refreshed: true };
      } catch (error) {
        if (error?.code !== 'ksef_auth_failed') throw error;
      }
    }
    session = await getAuthSession(credential, entity, { includeSecrets: true });
    return { credential, entity, session, ...(await fullXadesAuthentication(credential, entity, session)) };
  } catch (error) {
    session.lastError = clean(error?.message || error, 1000);
    try { await session.save(); } catch (_) { /* best effort diagnostic only */ }
    await recordXadesCredentialError(credential.credentialId, error);
    throw error;
  }
}

async function checkXadesCredential(credentialId, legalEntityId) {
  const result = await getXadesAccessToken(credentialId, legalEntityId, { forceReauthenticate: true });
  return {
    ok: true,
    credentialId: result.credential.credentialId,
    legalEntityId: String(result.entity._id),
    environment: result.credential.environment,
    authenticationMethod: 'xades',
  };
}

module.exports = {
  authSessionId,
  resolveLegalEntityForXades,
  getXadesAccessToken,
  checkXadesCredential,
};
