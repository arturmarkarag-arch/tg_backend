'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const AllegroAccount = require('../models/AllegroAccount');
const { appError } = require('../utils/errors');

const SETTING_KEY = 'allegro.oauth.config.v1';
const LEGACY_TOKEN_KEY_ENV = 'ALLEGRO_TOKEN_ENCRYPTION_KEY';
const SECRET_ROOT_ENV = 'APP_SETTINGS_ENCRYPTION_KEY';

let cached = null;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
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

function normalizeEnvironment(value) {
  return clean(value, 32).toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

function rootSecretRaw() {
  return clean(process.env[SECRET_ROOT_ENV], 4096) || clean(process.env.JWT_SECRET, 4096);
}

function rootKey() {
  const raw = rootSecretRaw();
  if (!raw) throw appError('allegro_config_secret_storage_not_configured');
  return crypto.createHash('sha256').update(`allegro-config:v1:${raw}`, 'utf8').digest();
}

function encryptConfigSecret(secret, kind) {
  const value = clean(secret, 32768);
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rootKey(), iv);
  cipher.setAAD(Buffer.from(`${SETTING_KEY}:${clean(kind, 64)}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptConfigSecret(payload, kind) {
  if (!payload) return '';
  if (Number(payload.version) !== 1 || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw appError('allegro_config_secret_decrypt_failed');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', rootKey(), Buffer.from(String(payload.iv), 'base64'));
    decipher.setAAD(Buffer.from(`${SETTING_KEY}:${clean(kind, 64)}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(String(payload.tag), 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(String(payload.ciphertext), 'base64')),
      decipher.final(),
    ]).toString('utf8').trim();
  } catch (_) {
    throw appError('allegro_config_secret_decrypt_failed');
  }
}

function legacyConfiguration() {
  return {
    environment: normalizeEnvironment(process.env.ALLEGRO_ENVIRONMENT),
    clientId: clean(process.env.ALLEGRO_CLIENT_ID, 512),
    clientSecret: clean(process.env.ALLEGRO_CLIENT_SECRET, 4096),
    redirectUri: absoluteHttpUrl(process.env.ALLEGRO_REDIRECT_URI),
    userAgent: clean(process.env.ALLEGRO_USER_AGENT, 512),
    tokenEncryptionKey: clean(process.env[LEGACY_TOKEN_KEY_ENV], 4096),
    source: 'env',
  };
}

function fromStored(value = {}) {
  return {
    environment: normalizeEnvironment(value.environment),
    clientId: clean(value.clientId, 512),
    clientSecret: decryptConfigSecret(value.clientSecretEncrypted, 'client-secret'),
    redirectUri: absoluteHttpUrl(value.redirectUri),
    userAgent: clean(value.userAgent, 512),
    tokenEncryptionKey: decryptConfigSecret(value.tokenEncryptionKeyEncrypted, 'token-encryption-key'),
    source: 'db',
  };
}

function usableConfig(config) {
  return Boolean(config?.clientId || config?.clientSecret || config?.redirectUri || config?.userAgent || config?.tokenEncryptionKey);
}

function completeConfig(config) {
  return Boolean(config?.clientId && config?.clientSecret && config?.redirectUri && config?.userAgent && config?.tokenEncryptionKey);
}

function currentAllegroConfiguration() {
  if (cached) return { ...cached };
  const legacy = legacyConfiguration();
  return usableConfig(legacy) ? legacy : { ...legacy, source: 'none' };
}

async function loadAllegroConfiguration({ migrateLegacy = false } = {}) {
  const row = await AppSetting.findOne({ key: SETTING_KEY }).lean();
  if (row?.value) {
    cached = fromStored(row.value);
    return currentAllegroConfiguration();
  }

  const legacy = legacyConfiguration();
  cached = usableConfig(legacy) ? legacy : { ...legacy, source: 'none' };
  if (migrateLegacy && completeConfig(legacy) && rootSecretRaw()) {
    await persistConfiguration(legacy, { source: 'env-migration' });
  }
  return currentAllegroConfiguration();
}

async function hasDurableCredentials() {
  return Boolean(await AllegroAccount.exists({
    $or: [
      { allegroUserId: { $exists: true, $nin: ['', null] } },
      { accessTokenEncrypted: { $exists: true, $ne: null } },
      { refreshTokenEncrypted: { $exists: true, $ne: null } },
    ],
  }));
}

async function persistConfiguration(config, { source = 'admin' } = {}) {
  const stored = {
    version: 1,
    environment: normalizeEnvironment(config.environment),
    clientId: clean(config.clientId, 512),
    clientSecretEncrypted: encryptConfigSecret(config.clientSecret, 'client-secret'),
    redirectUri: absoluteHttpUrl(config.redirectUri),
    userAgent: clean(config.userAgent, 512),
    tokenEncryptionKeyEncrypted: encryptConfigSecret(config.tokenEncryptionKey, 'token-encryption-key'),
    source: clean(source, 32) || 'admin',
    updatedAt: new Date(),
  };
  await AppSetting.findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { value: stored } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  cached = { ...config, source: 'db' };
  return currentAllegroConfiguration();
}

async function saveAllegroConfiguration(patch = {}) {
  if (!rootSecretRaw()) throw appError('allegro_config_secret_storage_not_configured');
  const previous = currentAllegroConfiguration();
  const next = {
    environment: patch.environment !== undefined ? normalizeEnvironment(patch.environment) : previous.environment,
    clientId: patch.clientId !== undefined ? clean(patch.clientId, 512) : previous.clientId,
    clientSecret: clean(patch.clientSecret, 4096) || previous.clientSecret,
    redirectUri: patch.redirectUri !== undefined ? absoluteHttpUrl(patch.redirectUri) : previous.redirectUri,
    userAgent: patch.userAgent !== undefined ? clean(patch.userAgent, 512) : previous.userAgent,
    tokenEncryptionKey: clean(patch.tokenEncryptionKey, 4096) || previous.tokenEncryptionKey,
  };

  if (patch.redirectUri !== undefined && clean(patch.redirectUri, 2048) && !next.redirectUri) {
    throw appError('allegro_config_redirect_uri_invalid');
  }
  if (!next.clientId) throw appError('allegro_config_client_id_required');
  if (!next.clientSecret) throw appError('allegro_config_client_secret_required');
  if (!next.redirectUri) throw appError('allegro_config_redirect_uri_required');
  if (!next.userAgent) throw appError('allegro_config_user_agent_required');
  if (!next.tokenEncryptionKey) throw appError('allegro_config_token_key_required');

  const durable = await hasDurableCredentials();
  if (durable) {
    if (previous.environment && next.environment !== previous.environment) throw appError('allegro_config_environment_locked');
    if (previous.clientId && next.clientId !== previous.clientId) throw appError('allegro_config_client_id_locked');
    if (previous.tokenEncryptionKey && next.tokenEncryptionKey !== previous.tokenEncryptionKey) {
      throw appError('allegro_config_token_key_locked');
    }
  }

  return persistConfiguration(next, { source: 'admin' });
}

function publicAllegroConfigurationState() {
  const config = currentAllegroConfiguration();
  return {
    source: config.source || 'none',
    environment: config.environment || 'production',
    clientId: config.clientId || '',
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUri: config.redirectUri || '',
    redirectUriConfigured: Boolean(config.redirectUri),
    userAgent: config.userAgent || '',
    userAgentConfigured: Boolean(config.userAgent),
    tokenEncryptionConfigured: Boolean(config.tokenEncryptionKey),
    secretStorageConfigured: Boolean(rootSecretRaw()),
  };
}

module.exports = {
  SETTING_KEY,
  LEGACY_TOKEN_KEY_ENV,
  SECRET_ROOT_ENV,
  loadAllegroConfiguration,
  currentAllegroConfiguration,
  saveAllegroConfiguration,
  publicAllegroConfigurationState,
};
