'use strict';

const DEFAULT_ALLOWED_SUFFIX = 'epfky0s.mongodb.net';

function allowedSuffix() {
  return String(process.env.LIVE_E2E_ALLOWED_DB_HOST || DEFAULT_ALLOWED_SUFFIX).trim().toLowerCase();
}

function mongoHostFromUri(uri) {
  const raw = String(uri || '').trim();
  const m = raw.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?]+)/i);
  if (!m) return '';
  return String(m[1] || '').split(',')[0].split(':')[0].toLowerCase();
}

function hostAllowed(host) {
  const h = String(host || '').trim().toLowerCase();
  const suffix = allowedSuffix();
  return Boolean(h && suffix && (h === suffix || h.endsWith(`.${suffix}`)));
}

function maskMongoUri(uri) {
  return String(uri || '').replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
}

function assertEnvUriAllowed(uri) {
  const host = mongoHostFromUri(uri);
  if (!hostAllowed(host)) {
    const err = new Error(
      `REFUSE TO RUN LIVE E2E: env Mongo host=${host || 'unknown'} is not allowed; ` +
      `expected suffix=${allowedSuffix()}; uri=${maskMongoUri(uri)}`
    );
    err.code = 'LIVE_E2E_DB_GUARD';
    throw err;
  }
  return host;
}

function assertConnectedHostAllowed(host) {
  if (!hostAllowed(host)) {
    const err = new Error(
      `REFUSE TO RUN LIVE E2E: connected Mongo host=${host || 'unknown'} is not allowed; ` +
      `expected suffix=${allowedSuffix()}`
    );
    err.code = 'LIVE_E2E_DB_GUARD';
    throw err;
  }
  return String(host || '').toLowerCase();
}

module.exports = {
  DEFAULT_ALLOWED_SUFFIX,
  allowedSuffix,
  mongoHostFromUri,
  hostAllowed,
  maskMongoUri,
  assertEnvUriAllowed,
  assertConnectedHostAllowed,
};
