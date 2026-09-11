'use strict';

const AppSetting = require('../models/AppSetting');

// Stage 4.1 briefly allowed Allegro application credentials to be managed from
// the admin UI. We intentionally reverted that design: application credentials
// are deployment secrets/configuration and now come only from backend env.
// Seller OAuth tokens remain per-account, encrypted in AllegroAccount.
const LEGACY_SETTING_KEY = 'allegro.oauth.config.v1';
const TOKEN_KEY_ENV = 'ALLEGRO_TOKEN_ENCRYPTION_KEY';

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

function currentAllegroConfiguration() {
  return {
    environment: normalizeEnvironment(process.env.ALLEGRO_ENVIRONMENT),
    clientId: clean(process.env.ALLEGRO_CLIENT_ID, 512),
    clientSecret: clean(process.env.ALLEGRO_CLIENT_SECRET, 4096),
    redirectUri: absoluteHttpUrl(process.env.ALLEGRO_REDIRECT_URI),
    userAgent: clean(process.env.ALLEGRO_USER_AGENT, 512),
    tokenEncryptionKey: clean(process.env[TOKEN_KEY_ENV], 4096),
    source: 'env',
  };
}

async function purgeLegacyStoredAllegroConfiguration() {
  // Removes only the temporary Stage 4.1 shared application config. It never
  // touches AllegroAccount OAuth credentials, identities, cursors or orders.
  try {
    await AppSetting.deleteOne({ key: LEGACY_SETTING_KEY });
  } catch (_) {
    // Env remains authoritative even if this housekeeping delete is delayed.
  }
}

async function loadAllegroConfiguration() {
  await purgeLegacyStoredAllegroConfiguration();
  return currentAllegroConfiguration();
}

function publicAllegroConfigurationState() {
  const config = currentAllegroConfiguration();
  return {
    source: 'env',
    environment: config.environment,
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUriConfigured: Boolean(config.redirectUri),
    userAgentConfigured: Boolean(config.userAgent),
    tokenEncryptionConfigured: Boolean(config.tokenEncryptionKey),
  };
}

module.exports = {
  LEGACY_SETTING_KEY,
  TOKEN_KEY_ENV,
  loadAllegroConfiguration,
  purgeLegacyStoredAllegroConfiguration,
  currentAllegroConfiguration,
  publicAllegroConfigurationState,
};
