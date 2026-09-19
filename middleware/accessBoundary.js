'use strict';

const crypto = require('crypto');
const {
  readBrowserSessionProof,
  readTelegramSessionProof,
  readContextSessionProof,
} = require('./sessionProof');
const { readTelegramSessionSlot } = require('../utils/telegramRequestIdentity');
const { appError } = require('../utils/errors');

// There is deliberately NO broad public namespace. Every inbound server path
// falls into one of these explicit proof classes; everything else requires a
// normal first-party user session and, for API routes, the authoritative
// telegramAuth middleware later in app.js.
const ANONYMOUS_ENTRY_API_PATHS = Object.freeze([
  // Browser/Telegram login bootstrap. These endpoints authenticate the caller
  // themselves with signed Telegram initData or Google credentials.
  /^\/api\/v1\/auth\/config$/,
  /^\/api\/v1\/auth\/telegram\/bootstrap$/,
  /^\/api\/v1\/auth\/telegram\/diagnostic$/,
  /^\/api\/v1\/auth\/google$/,
  /^\/api\/v1\/auth\/google\/link\/bootstrap$/,
  /^\/api\/v1\/auth\/google\/link\/complete$/,

  // Minimal liveness probe for Render/Cloudflare monitoring. It exposes no
  // user/business data and is intentionally the only ordinary anonymous read.
  /^\/api\/health$/,

  // Allegro redirects the browser without our app cookie. The route itself
  // authenticates the callback using a high-entropy one-time OAuth state.
  /^\/api\/allegro\/oauth\/callback$/,
]);

const TELEGRAM_PROOF_API_PATHS = Object.freeze([
  // Pre-registration/check flows happen before a User row exists, therefore
  // full telegramAuth cannot run. They still require our signed first-party
  // Telegram proof cookie created by /auth/telegram/bootstrap.
  /^\/api\/v1\/telegram\/validate$/,
  /^\/api\/v1\/telegram\/me$/,
  /^\/api\/v1\/telegram\/registration-invite$/,
  /^\/api\/v1\/telegram\/register-request$/,
]);

const CONTEXT_PROOF_API_PATHS = Object.freeze([
  // Registration needs these reads before a User row exists, while the same
  // reference data is also used by already-authenticated browser sessions.
  // Accept the proof selected by x-auth-context: Telegram for pre-registration,
  // browser otherwise. The route performs the matching authoritative check.
  /^\/api\/shops\/cities$/,
  /^\/api\/shops\/registry$/,
]);

const BROWSER_PROOF_API_PATHS = Object.freeze([
  // Browser session probe/logout must be callable before app state is known,
  // but only when a cryptographically valid browser session cookie exists.
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/auth\/logout$/,
]);

const SERVICE_TOKEN_API_PATHS = Object.freeze([
  // Local Windows print service uses its own long random token, never app-user
  // auth. The route keeps a second token check as defense in depth.
  /^\/api\/print-agent(?:\/.*)?$/,
]);

function matchesAny(patterns, pathname) {
  const value = String(pathname || '');
  return patterns.some((pattern) => pattern.test(value));
}

function isAnonymousEntryApiPath(pathname) {
  return matchesAny(ANONYMOUS_ENTRY_API_PATHS, pathname);
}

function isTelegramProofApiPath(pathname) {
  return matchesAny(TELEGRAM_PROOF_API_PATHS, pathname);
}

function isBrowserProofApiPath(pathname) {
  return matchesAny(BROWSER_PROOF_API_PATHS, pathname);
}

function isContextProofApiPath(pathname) {
  return matchesAny(CONTEXT_PROOF_API_PATHS, pathname);
}

function isServiceTokenApiPath(pathname) {
  return matchesAny(SERVICE_TOKEN_API_PATHS, pathname);
}

function isUserAuthBypassApiPath(pathname) {
  return isAnonymousEntryApiPath(pathname)
    || isTelegramProofApiPath(pathname)
    || isContextProofApiPath(pathname)
    || isBrowserProofApiPath(pathname)
    || isServiceTokenApiPath(pathname);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hasValidPrintAgentToken(req) {
  if (!isServiceTokenApiPath(req?.path)) return false;
  const expected = String(process.env.BASELINKER_PRINT_AGENT_TOKEN || '').trim();
  const actual = String(req?.get?.('x-print-agent-token') || '').trim();
  return Boolean(expected && safeEqual(actual, expected));
}

/**
 * Cheap ingress proof boundary.
 *
 * Runs BEFORE express.json() and BEFORE Mongo-backed telegramAuth. It never
 * decides roles or account state. Its job is only to make sure that arbitrary
 * anonymous traffic cannot reach body parsing, static folders or normal API
 * routing.
 */
function createStrictAccessBoundary() {
  return function strictAccessBoundary(req, _res, next) {
    const method = String(req?.method || '').toUpperCase();
    const pathname = String(req?.path || '');

    // Required for browser CORS preflight. OPTIONS exposes no application data.
    if (method === 'OPTIONS') return next();

    // Exact login/bootstrap/health/OAuth callback entries authenticate inside
    // their own route and are the only paths allowed without an existing proof.
    if (isAnonymousEntryApiPath(pathname)) return next();

    if (isServiceTokenApiPath(pathname)) {
      if (hasValidPrintAgentToken(req)) return next();
      return next(appError('print_agent_unauthorized'));
    }

    if (isTelegramProofApiPath(pathname)) {
      const slot = readTelegramSessionSlot(req);
      if (readTelegramSessionProof(req, slot)) return next();
      return next(appError('auth_telegram_session_required'));
    }

    if (isContextProofApiPath(pathname)) {
      const proof = readContextSessionProof(req);
      if (proof?.session) return next();
      return next(appError(proof?.kind === 'telegram'
        ? 'auth_telegram_session_required'
        : 'auth_required'));
    }

    if (isBrowserProofApiPath(pathname)) {
      if (readBrowserSessionProof(req)) return next();
      return next(appError('auth_required'));
    }

    // Everything else on the server — every API namespace, every static folder
    // and every unknown path — requires a valid first-party session proof.
    // Normal API routes are then checked authoritatively against Mongo + roles.
    const proof = readContextSessionProof(req);
    if (proof?.session) return next();
    return next(appError(proof?.kind === 'telegram'
      ? 'auth_telegram_session_required'
      : 'auth_required'));
  };
}

module.exports = {
  ANONYMOUS_ENTRY_API_PATHS,
  TELEGRAM_PROOF_API_PATHS,
  CONTEXT_PROOF_API_PATHS,
  BROWSER_PROOF_API_PATHS,
  SERVICE_TOKEN_API_PATHS,
  isAnonymousEntryApiPath,
  isTelegramProofApiPath,
  isContextProofApiPath,
  isBrowserProofApiPath,
  isServiceTokenApiPath,
  isUserAuthBypassApiPath,
  hasValidPrintAgentToken,
  createStrictAccessBoundary,
};
