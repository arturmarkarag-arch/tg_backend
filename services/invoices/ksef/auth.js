'use strict';

const LegalEntity = require('../../../models/LegalEntity');
const { appError } = require('../../../utils/errors');
const { PUBLIC_KEY_USAGE } = require('./config');
const { ksefRequest } = require('./http');
const { getPublicKey, invalidatePublicKeys } = require('./publicKeys');
const { rsaOaepSha256Encrypt } = require('./crypto');
const {
  getConnection, decryptKsefToken, decryptAccessToken, decryptRefreshToken, saveSessionTokens, recordConnectionError,
} = require('./connections');

const ACCESS_MARGIN_MS = 60_000;
const AUTH_WAIT_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function validUntil(date, margin = ACCESS_MARGIN_MS) { return date && new Date(date).getTime() - margin > Date.now(); }
function isRotatedKeyError(error) { return String(error?.args?.providerCode || error?.ksef?.providerCode || '') === '21470'; }

async function refreshAccessToken(connection) {
  if (!validUntil(connection.refreshTokenValidUntil, 5_000) || !connection.refreshTokenEncrypted) return '';
  const refreshToken = decryptRefreshToken(connection);
  const response = await ksefRequest(connection.environment, '/auth/token/refresh', { method: 'POST', token: refreshToken });
  const access = response.body?.accessToken;
  if (!access?.token || !access?.validUntil) throw appError('ksef_auth_response_invalid');
  await saveSessionTokens(connection, { accessToken: access.token, accessTokenValidUntil: access.validUntil });
  return access.token;
}

async function waitForAuthentication(connection, referenceNumber, authenticationToken) {
  const deadline = Date.now() + AUTH_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await ksefRequest(connection.environment, `/auth/${encodeURIComponent(referenceNumber)}`, { token: authenticationToken });
    const statusCode = Number(response.body?.status?.code || 0);
    if (statusCode === 200) return response.body;
    if (statusCode >= 400) throw appError('ksef_auth_rejected', { providerStatus: response.body?.status || null });
    await sleep(400);
  }
  throw appError('ksef_auth_timeout');
}

async function initializeTokenAuthentication(connection, entity, { forceKeys = false } = {}) {
  const challengeResponse = await ksefRequest(connection.environment, '/auth/challenge', { method: 'POST' });
  const challenge = challengeResponse.body?.challenge;
  const timestampMs = challengeResponse.body?.timestampMs;
  if (!challenge || timestampMs === undefined || timestampMs === null) throw appError('ksef_auth_response_invalid');
  const token = decryptKsefToken(connection);
  const publicKey = await getPublicKey(connection.environment, PUBLIC_KEY_USAGE.TOKEN, { force: forceKeys });
  const encryptedToken = rsaOaepSha256Encrypt(`${token}|${timestampMs}`, publicKey.publicKey);
  const init = await ksefRequest(connection.environment, '/auth/ksef-token', {
    method: 'POST',
    body: {
      challenge,
      contextIdentifier: { type: 'Nip', value: String(entity.taxId) },
      encryptedToken,
      publicKeyId: publicKey.publicKeyId,
    },
  });
  const referenceNumber = init.body?.referenceNumber;
  const authenticationToken = init.body?.authenticationToken?.token;
  if (!referenceNumber || !authenticationToken) throw appError('ksef_auth_response_invalid');
  return { referenceNumber, authenticationToken, tokenPublicKeyId: publicKey.publicKeyId };
}

async function fullAuthentication(connection) {
  const entity = await LegalEntity.findById(connection.legalEntityId).lean();
  if (!entity?.taxId || entity.countryCode !== 'PL' || entity.taxIdType !== 'nip') throw appError('ksef_legal_entity_nip_required');
  let initialized;
  try {
    initialized = await initializeTokenAuthentication(connection, entity);
  } catch (error) {
    if (!isRotatedKeyError(error)) throw error;
    invalidatePublicKeys(connection.environment);
    initialized = await initializeTokenAuthentication(connection, entity, { forceKeys: true });
  }
  await waitForAuthentication(connection, initialized.referenceNumber, initialized.authenticationToken);
  const redeemed = await ksefRequest(connection.environment, '/auth/token/redeem', { method: 'POST', token: initialized.authenticationToken });
  const access = redeemed.body?.accessToken;
  const refresh = redeemed.body?.refreshToken;
  if (!access?.token || !access?.validUntil || !refresh?.token || !refresh?.validUntil) throw appError('ksef_auth_response_invalid');
  await saveSessionTokens(connection, {
    accessToken: access.token,
    accessTokenValidUntil: access.validUntil,
    refreshToken: refresh.token,
    refreshTokenValidUntil: refresh.validUntil,
  });
  return { accessToken: access.token, tokenPublicKeyId: initialized.tokenPublicKeyId, refreshed: false, authenticated: true };
}

async function getAccessToken(connectionId, { forceReauthenticate = false } = {}) {
  const connection = await getConnection(connectionId, { includeSecrets: true, requireEnabled: true });
  try {
    if (!forceReauthenticate && validUntil(connection.accessTokenValidUntil) && connection.accessTokenEncrypted) {
      return { connection, accessToken: decryptAccessToken(connection), tokenPublicKeyId: '', refreshed: false, authenticated: false };
    }
    if (!forceReauthenticate) {
      try {
        const accessToken = await refreshAccessToken(connection);
        if (accessToken) return { connection, accessToken, tokenPublicKeyId: '', refreshed: true, authenticated: false };
      } catch (error) {
        if (error?.code !== 'ksef_auth_failed') throw error;
      }
    }
    return { connection, ...(await fullAuthentication(connection)) };
  } catch (error) {
    await recordConnectionError(connection.connectionId, error);
    throw error;
  }
}

async function checkConnection(connectionId) {
  const result = await getAccessToken(connectionId, { forceReauthenticate: true });
  return { ok: true, connectionId: result.connection.connectionId, environment: result.connection.environment, authenticated: true };
}

module.exports = { getAccessToken, checkConnection, isRotatedKeyError };
