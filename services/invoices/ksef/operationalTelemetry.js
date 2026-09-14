'use strict';

const { sanitizeOperationalPath } = require('./operationalPolicy');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function safeEnvironment(value) {
  const env = clean(value, 16).toLowerCase();
  return ['test', 'demo', 'prod'].includes(env) ? env : '';
}
function safeActor(actor) {
  if (!actor) return null;
  return { id: clean(actor.id, 128), name: clean(actor.name, 256), role: clean(actor.role, 64) };
}
function getOperationalEventModel() {
  // Lazy require keeps provider HTTP/pure crypto-policy tests dependency-free.
  return require('../../../models/KsefOperationalEvent');
}
async function recordOperationalEvent(event = {}) {
  try {
    const KsefOperationalEvent = getOperationalEventModel();
    return await KsefOperationalEvent.create({
      at: event.at || new Date(),
      kind: event.kind,
      severity: event.severity || 'info',
      environment: safeEnvironment(event.environment),
      legalEntityId: event.legalEntityId || null,
      resourceType: clean(event.resourceType, 64),
      resourceId: clean(event.resourceId, 160),
      code: clean(event.code, 128),
      httpStatus: Number(event.httpStatus || 0) || null,
      providerCode: clean(event.providerCode, 128),
      method: clean(event.method, 16).toUpperCase(),
      path: sanitizeOperationalPath(event.path),
      message: clean(event.message, 1000),
      retryAfter: clean(event.retryAfter, 128),
      actor: safeActor(event.actor),
      details: event.details && typeof event.details === 'object' ? event.details : null,
    });
  } catch (_) {
    // Diagnostics must never break the fiscal operation they describe.
    return null;
  }
}
function recordOperationalEventBestEffort(event) {
  Promise.resolve(recordOperationalEvent(event)).catch(() => {});
}
function recordHttpFailure({ environment, method, path, error } = {}) {
  const httpStatus = Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) || null;
  const code = clean(error?.code || 'ksef_http_error', 128);
  const severity = code === 'ksef_rate_limited' || httpStatus === 429 ? 'warn' : 'error';
  if (!(code === 'ksef_rate_limited' || code === 'ksef_api_timeout' || code === 'ksef_api_unavailable' || code === 'ksef_auth_failed' || (httpStatus && httpStatus >= 500))) return;
  recordOperationalEventBestEffort({
    kind: code === 'ksef_rate_limited' || httpStatus === 429 ? 'rate_limit' : 'http_error',
    severity,
    environment,
    code,
    httpStatus,
    providerCode: error?.args?.providerCode || error?.ksef?.providerCode || '',
    method,
    path,
    message: error?.args?.providerMessage || error?.message || code,
    retryAfter: error?.args?.retryAfter || error?.ksef?.retryAfter || '',
  });
}

module.exports = { recordOperationalEvent, recordOperationalEventBestEffort, recordHttpFailure, sanitizePath: sanitizeOperationalPath };
