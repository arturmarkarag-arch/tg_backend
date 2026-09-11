'use strict';

const { shouldReuseRotatedTokenAfterForcedRefresh } = require('./allegroRuntimePolicy');

const crypto = require('crypto');
const AllegroAccount = require('../models/AllegroAccount');
const AllegroOAuthState = require('../models/AllegroOAuthState');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');

const TOKEN_KEY_ENV = 'ALLEGRO_TOKEN_ENCRYPTION_KEY';
const { currentAllegroConfiguration, publicAllegroConfigurationState } = require('./allegroConfiguration');
const DEFAULT_SCOPES = [
  'allegro:api:profile:read',
  'allegro:api:orders:read',
  'allegro:api:orders:write',
  'allegro:api:shipments:read',
  'allegro:api:shipments:write',
];
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_MIN_VALIDITY_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function uniqueStrings(values, max = 160) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, max))
    .filter(Boolean))];
}

function parseScopes(value, { useDefaults = true } = {}) {
  const raw = clean(value, 4096);
  if (!raw) return useDefaults ? [...DEFAULT_SCOPES] : [];
  return uniqueStrings(raw.split(/[\s,]+/g), 160);
}

function absoluteHttpUrl(value) {
  const raw = clean(value, 2048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function oauthConfiguration() {
  const stored = currentAllegroConfiguration();
  const environment = stored.environment === 'sandbox' ? 'sandbox' : 'production';
  const clientId = clean(stored.clientId, 512);
  const clientSecret = clean(stored.clientSecret, 4096);
  const redirectUri = absoluteHttpUrl(stored.redirectUri);
  const userAgent = clean(stored.userAgent, 512);
  const tokenKeyConfigured = Boolean(clean(stored.tokenEncryptionKey, 4096));
  const webAppUrl = absoluteHttpUrl(process.env.WEB_APP_URL);
  const scopes = parseScopes(process.env.ALLEGRO_OAUTH_SCOPES);
  const authBaseUrl = environment === 'sandbox'
    ? 'https://allegro.pl.allegrosandbox.pl/auth/oauth'
    : 'https://allegro.pl/auth/oauth';
  const apiBaseUrl = environment === 'sandbox'
    ? 'https://api.allegro.pl.allegrosandbox.pl'
    : 'https://api.allegro.pl';

  const missing = [];
  if (!clientId) missing.push('ALLEGRO_CLIENT_ID');
  if (!clientSecret) missing.push('ALLEGRO_CLIENT_SECRET');
  if (!redirectUri) missing.push('ALLEGRO_REDIRECT_URI');
  if (!userAgent) missing.push('ALLEGRO_USER_AGENT');
  if (!tokenKeyConfigured) missing.push('ALLEGRO_TOKEN_ENCRYPTION_KEY');
  if (!webAppUrl) missing.push('WEB_APP_URL');

  return {
    environment,
    clientId,
    clientSecret,
    redirectUri,
    userAgent,
    tokenKeyConfigured,
    webAppUrl,
    scopes,
    authBaseUrl,
    apiBaseUrl,
    missing,
    oauthConfigured: missing.length === 0,
  };
}

function publicOAuthConfiguration() {
  const config = oauthConfiguration();
  const state = publicAllegroConfigurationState();
  return {
    source: state.source,
    environment: config.environment,
    oauthConfigured: config.oauthConfigured,
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUriConfigured: Boolean(config.redirectUri),
    userAgentConfigured: Boolean(config.userAgent),
    tokenEncryptionConfigured: config.tokenKeyConfigured,
    webAppUrlConfigured: Boolean(config.webAppUrl),
    scopes: config.scopes,
    missing: config.missing,
  };
}

function requireOAuthConfiguration() {
  const config = oauthConfiguration();
  if (!config.oauthConfigured) throw appError('allegro_oauth_not_configured', { missing: config.missing });
  return config;
}

function getEncryptionKey({ required = true } = {}) {
  const raw = clean(currentAllegroConfiguration().tokenEncryptionKey, 4096);
  if (!raw) {
    if (required) throw appError('allegro_token_encryption_not_configured');
    return null;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encryptSecret(secret, accountId, kind) {
  const value = clean(secret, 32_768);
  const id = clean(accountId, 64);
  const normalizedKind = clean(kind, 32);
  if (!value || !id || !normalizedKind) throw appError('allegro_token_encrypt_failed');
  const key = getEncryptionKey({ required: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${id}:${normalizedKind}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(payload, accountId, kind) {
  if (!payload || Number(payload.version) !== 1 || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw appError('allegro_token_decrypt_failed');
  }
  const id = clean(accountId, 64);
  const normalizedKind = clean(kind, 32);
  const key = getEncryptionKey({ required: true });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(payload.iv), 'base64'));
    decipher.setAAD(Buffer.from(`${id}:${normalizedKind}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(String(payload.tag), 'base64'));
    const value = Buffer.concat([
      decipher.update(Buffer.from(String(payload.ciphertext), 'base64')),
      decipher.final(),
    ]).toString('utf8').trim();
    if (!value) throw new Error('empty secret');
    return value;
  } catch (_) {
    throw appError('allegro_token_decrypt_failed');
  }
}

function stateHash(state) {
  return crypto.createHash('sha256').update(clean(state, 512), 'utf8').digest('hex');
}

function safeTraceId(response) {
  return clean(response?.headers?.get?.('trace-id') || response?.headers?.get?.('x-trace-id'), 256);
}

async function readPayload(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return { rawText: clean(text, 500) }; }
}

function upstreamCode(payload) {
  return clean(
    payload?.error
      || payload?.errors?.[0]?.code
      || payload?.code,
    160,
  );
}

async function fetchJson(url, options, errorCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw appError('allegro_upstream_timeout');
    throw appError('allegro_upstream_unavailable');
  }
  clearTimeout(timer);
  const payload = await readPayload(response);
  if (!response.ok) {
    throw appError(errorCode, {
      upstreamStatus: response.status,
      upstreamCode: upstreamCode(payload),
      traceId: safeTraceId(response),
    });
  }
  return { payload, traceId: safeTraceId(response) };
}

function basicAuthorization(config) {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`;
}

function tokenExpiry(expiresIn) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) throw appError('allegro_oauth_token_response_invalid');
  return new Date(Date.now() + Math.floor(seconds * 1000));
}

function normalizedTokenPayload(payload) {
  const accessToken = clean(payload?.access_token, 32_768);
  const refreshToken = clean(payload?.refresh_token, 32_768);
  if (!accessToken || !refreshToken) throw appError('allegro_oauth_token_response_invalid');
  return {
    accessToken,
    refreshToken,
    tokenType: clean(payload?.token_type, 32) || 'bearer',
    scopes: parseScopes(payload?.scope, { useDefaults: false }),
    expiresAt: tokenExpiry(payload?.expires_in),
  };
}

async function exchangeAuthorizationCode(code) {
  const config = requireOAuthConfiguration();
  const authorizationCode = clean(code, 4096);
  if (!authorizationCode) throw appError('allegro_oauth_code_required');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: config.redirectUri,
  });
  const { payload } = await fetchJson(`${config.authBaseUrl}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(config),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.userAgent,
    },
    body: body.toString(),
  }, 'allegro_oauth_exchange_failed');
  return normalizedTokenPayload(payload);
}

async function exchangeRefreshToken(refreshToken) {
  const config = requireOAuthConfiguration();
  const value = clean(refreshToken, 32_768);
  if (!value) throw appError('allegro_refresh_token_missing');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: value });
  const { payload } = await fetchJson(`${config.authBaseUrl}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(config),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.userAgent,
    },
    body: body.toString(),
  }, 'allegro_oauth_refresh_failed');
  return normalizedTokenPayload(payload);
}

async function fetchAllegroIdentity(accessToken) {
  const config = requireOAuthConfiguration();
  const token = clean(accessToken, 32_768);
  if (!token) throw appError('allegro_access_token_missing');
  const { payload, traceId } = await fetchJson(`${config.apiBaseUrl}/me`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.allegro.public.v1+json',
      'Accept-Language': 'uk-UA',
      'User-Agent': config.userAgent,
    },
  }, 'allegro_identity_check_failed');
  const id = clean(payload?.id, 128);
  const login = clean(payload?.login, 160);
  if (!id || !login) throw appError('allegro_identity_response_invalid', { traceId });
  return {
    id,
    login,
    baseMarketplaceId: clean(payload?.baseMarketplace?.id, 80),
    traceId,
  };
}

function tokenLockKey(accountId) {
  return `allegro-account:${clean(accountId, 64)}:token`;
}

function withAllegroTokenLock(accountId, fn) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  return withLock(tokenLockKey(id), fn, { ttlMs: 30_000, waitMs: 12_000 });
}

function tokenRevisionFilter(row) {
  const revision = Math.max(0, Number(row?.tokenRevision) || 0);
  if (revision === 0) {
    return { $or: [{ tokenRevision: 0 }, { tokenRevision: { $exists: false } }] };
  }
  return { tokenRevision: revision };
}

async function credentialRow(accountId) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  const row = await AllegroAccount.findOne({ accountId: id })
    .select('+accessTokenEncrypted +refreshTokenEncrypted');
  if (!row) throw appError('allegro_account_not_found');
  return row;
}

async function saveTokenPair(row, tokenPair, extraSet = {}) {
  const now = new Date();
  const revision = Math.max(0, Number(row.tokenRevision) || 0);
  const filter = { _id: row._id, ...tokenRevisionFilter(row) };
  const scopes = uniqueStrings(tokenPair.scopes?.length ? tokenPair.scopes : row.scopes, 160);
  const updated = await AllegroAccount.findOneAndUpdate(filter, {
    $set: {
      accessTokenEncrypted: encryptSecret(tokenPair.accessToken, row.accountId, 'access'),
      refreshTokenEncrypted: encryptSecret(tokenPair.refreshToken, row.accountId, 'refresh'),
      tokenExpiresAt: tokenPair.expiresAt,
      tokenRefreshedAt: now,
      scopes,
      authState: 'connected',
      lastConnectionError: '',
      ...extraSet,
    },
    $setOnInsert: {},
    $inc: { tokenRevision: 1 },
  }, { new: true });
  if (updated) return updated;

  // CAS lost: another worker rotated credentials first. Never overwrite its
  // refresh token with ours; the caller must re-read the winning credential set.
  const winning = await credentialRow(row.accountId);
  if (Number(winning.tokenRevision || 0) > revision) return winning;
  throw appError('allegro_token_rotation_conflict');
}

async function bindOAuthIdentity(accountId, identity, tokenPair) {
  return withAllegroTokenLock(accountId, async () => {
    const row = await credentialRow(accountId);
    const existingUserId = clean(row.allegroUserId, 128);
    if (existingUserId && existingUserId !== identity.id) {
      throw appError('allegro_oauth_identity_mismatch', {
        expectedLogin: clean(row.login, 160),
        receivedLogin: clean(identity.login, 160),
      });
    }
    const duplicate = await AllegroAccount.findOne({ allegroUserId: identity.id, accountId: { $ne: row.accountId } })
      .select('accountId name login')
      .lean();
    if (duplicate) {
      throw appError('allegro_account_already_connected', {
        connectedAccountId: clean(duplicate.accountId, 64),
        connectedAccountName: clean(duplicate.name, 160),
      });
    }

    const now = new Date();
    const updated = await saveTokenPair(row, tokenPair, {
      allegroUserId: identity.id,
      login: identity.login,
      marketplaceIds: identity.baseMarketplaceId ? [identity.baseMarketplaceId] : [],
      authConnectedAt: row.authConnectedAt || now,
      lastConnectionCheckAt: now,
    });
    return updated;
  });
}

async function createOAuthAttempt(accountId, requestedByTelegramId = '') {
  const config = requireOAuthConfiguration();
  const id = clean(accountId, 64);
  const row = await AllegroAccount.findOne({ accountId: id }).select('accountId');
  if (!row) throw appError('allegro_account_not_found');

  const state = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await AllegroOAuthState.deleteMany({ accountId: id });
  await AllegroOAuthState.create({
    stateHash: stateHash(state),
    accountId: id,
    requestedByTelegramId: clean(requestedByTelegramId, 64),
    expiresAt,
  });

  const authorize = new URL(`${config.authBaseUrl}/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', config.redirectUri);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'confirm');
  authorize.searchParams.set('scope', config.scopes.join(' '));

  return {
    authorizeUrl: authorize.toString(),
    expiresAt,
    scopes: config.scopes,
    environment: config.environment,
  };
}

async function consumeOAuthAttempt(state) {
  const raw = clean(state, 512);
  if (!raw) throw appError('allegro_oauth_state_invalid');
  const row = await AllegroOAuthState.findOneAndDelete({
    stateHash: stateHash(raw),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!row) throw appError('allegro_oauth_state_invalid');
  return row;
}

async function recordAttemptFailure(accountId, message, { draftState = 'error' } = {}) {
  const row = await AllegroAccount.findOne({ accountId: clean(accountId, 64) });
  if (!row) return;
  row.lastConnectionCheckAt = new Date();
  row.lastConnectionError = clean(message, 1000);
  // Failed re-authorization must never destroy an already working connection.
  if (!row.allegroUserId || row.authState !== 'connected') {
    row.authState = draftState;
    row.enabled = false;
  }
  await row.save().catch(() => {});
}

async function completeOAuthCallback({ state, code, error } = {}) {
  const attempt = await consumeOAuthAttempt(state);
  const accountId = clean(attempt.accountId, 64);
  if (error) {
    await recordAttemptFailure(accountId, `OAuth cancelled: ${clean(error, 160)}`, { draftState: 'authorization_required' });
    return { outcome: 'cancelled', accountId };
  }
  try {
    const tokenPair = await exchangeAuthorizationCode(code);
    const identity = await fetchAllegroIdentity(tokenPair.accessToken);
    const updated = await bindOAuthIdentity(accountId, identity, tokenPair);
    return {
      outcome: 'connected',
      accountId,
      identity: { id: identity.id, login: identity.login, baseMarketplaceId: identity.baseMarketplaceId },
      authState: clean(updated.authState, 32),
    };
  } catch (err) {
    await recordAttemptFailure(accountId, err?.message || 'OAuth failed');
    err.allegroAccountId = accountId;
    throw err;
  }
}

function isTokenUsable(row, minValidityMs = ACCESS_TOKEN_MIN_VALIDITY_MS) {
  const expiresAt = row?.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  return Boolean(row?.accessTokenEncrypted && Number.isFinite(expiresAt) && expiresAt - Date.now() > minValidityMs);
}

function permanentRefreshFailure(err) {
  const status = Number(err?.args?.upstreamStatus || 0);
  const code = clean(err?.args?.upstreamCode, 160).toLowerCase();
  return [400, 401].includes(status) && ['invalid_grant', 'invalid_token', 'unauthorized'].includes(code);
}

async function markRefreshExpired(accountId, err) {
  await AllegroAccount.updateOne({ accountId: clean(accountId, 64) }, {
    $set: {
      authState: 'expired',
      enabled: false,
      lastConnectionCheckAt: new Date(),
      lastConnectionError: clean(err?.message || 'Refresh token expired', 1000),
    },
  });
}

async function getValidAccessToken(accountId, { requireEnabled = true, forceRefresh = false, rejectedTokenRevision = null } = {}) {
  const id = clean(accountId, 64);
  let row = await credentialRow(id);
  if (requireEnabled && row.enabled !== true) throw appError('allegro_account_disabled');
  if (row.authState !== 'connected') throw appError('allegro_account_authorization_required');
  if (!forceRefresh && isTokenUsable(row)) {
    return { account: row, accessToken: decryptSecret(row.accessTokenEncrypted, row.accountId, 'access') };
  }

  return withAllegroTokenLock(id, async () => {
    row = await credentialRow(id);
    if (requireEnabled && row.enabled !== true) throw appError('allegro_account_disabled');
    if (row.authState !== 'connected') throw appError('allegro_account_authorization_required');

    // Several requests can discover the same rejected access token at once. If
    // another worker already rotated credentials while we were waiting for the
    // distributed lock, use that newer revision instead of consuming yet another
    // refresh token. This keeps forced 401 recovery serialized *and* deduplicated.
    if (shouldReuseRotatedTokenAfterForcedRefresh({
      forceRefresh,
      rejectedTokenRevision,
      currentTokenRevision: row.tokenRevision,
      tokenUsable: isTokenUsable(row, 0),
    })) {
      return { account: row, accessToken: decryptSecret(row.accessTokenEncrypted, row.accountId, 'access') };
    }
    if (!forceRefresh && isTokenUsable(row)) {
      return { account: row, accessToken: decryptSecret(row.accessTokenEncrypted, row.accountId, 'access') };
    }
    if (!row.refreshTokenEncrypted) throw appError('allegro_refresh_token_missing');
    const refreshToken = decryptSecret(row.refreshTokenEncrypted, row.accountId, 'refresh');
    let tokenPair;
    try {
      tokenPair = await exchangeRefreshToken(refreshToken);
    } catch (err) {
      if (permanentRefreshFailure(err)) await markRefreshExpired(id, err);
      throw err;
    }
    const updated = await saveTokenPair(row, tokenPair, { lastConnectionCheckAt: new Date() });
    // If our CAS lost, `updated` is the winning row; decrypt that winner rather
    // than returning the now-stale access token from our refresh response.
    const winner = updated.accessTokenEncrypted ? updated : await credentialRow(id);
    return { account: winner, accessToken: decryptSecret(winner.accessTokenEncrypted, winner.accountId, 'access') };
  });
}

function frontendOAuthRedirect({ outcome = 'error', accountId = '', errorCode = '' } = {}) {
  const config = oauthConfiguration();
  if (!config.webAppUrl) return '';
  const url = new URL(config.webAppUrl);
  url.searchParams.set('page', 'settings');
  url.searchParams.set('allegroOauth', clean(outcome, 32) || 'error');
  if (accountId) url.searchParams.set('allegroAccountId', clean(accountId, 64));
  if (errorCode) url.searchParams.set('allegroOauthError', clean(errorCode, 160));
  return url.toString();
}

module.exports = {
  TOKEN_KEY_ENV,
  DEFAULT_SCOPES,
  oauthConfiguration,
  publicOAuthConfiguration,
  requireOAuthConfiguration,
  encryptSecret,
  decryptSecret,
  createOAuthAttempt,
  completeOAuthCallback,
  getValidAccessToken,
  fetchAllegroIdentity,
  frontendOAuthRedirect,
  tokenLockKey,
  withAllegroTokenLock,
};
