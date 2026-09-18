'use strict';

const { consumeRateLimit } = require('./rateLimitCore');
const { getClientNetworkIdentity } = require('../utils/clientNetworkIdentity');
const { readContextSessionProof } = require('./sessionProof');
const { isAnonymousEntryApiPath, hasValidPrintAgentToken } = require('./accessBoundary');
const { appError } = require('../utils/errors');

function positiveEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveEnvIntCompat(primary, legacy, fallback) {
  if (process.env[primary] !== undefined) return positiveEnvInt(primary, fallback);
  return positiveEnvInt(legacy, fallback);
}

function defaultPolicies() {
  return {
    // Normal protected API paths have no useful anonymous workload. Keep this
    // deliberately tight: with two anonymous API calls per page reload, the
    // fourth rapid reload is already rate-limited by the default burst budget.
    protectedAnonymous: [
      { name: 'burst', max: positiveEnvInt('API_ANON_PROTECTED_BURST_MAX', 6), windowMs: positiveEnvInt('API_ANON_PROTECTED_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_ANON_PROTECTED_SUSTAINED_MAX', 24), windowMs: positiveEnvInt('API_ANON_PROTECTED_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    // Login/bootstrap/check endpoints need a little more room than protected
    // business APIs because a legitimate sign-in can involve several calls.
    entryAnonymous: [
      { name: 'burst', max: positiveEnvIntCompat('API_ANON_ENTRY_BURST_MAX', 'API_ANON_PUBLIC_BURST_MAX', 12), windowMs: positiveEnvIntCompat('API_ANON_ENTRY_BURST_WINDOW_MS', 'API_ANON_PUBLIC_BURST_WINDOW_MS', 30_000) },
      { name: 'sustained', max: positiveEnvIntCompat('API_ANON_ENTRY_SUSTAINED_MAX', 'API_ANON_PUBLIC_SUSTAINED_MAX', 60), windowMs: positiveEnvIntCompat('API_ANON_ENTRY_SUSTAINED_WINDOW_MS', 'API_ANON_PUBLIC_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    // A cryptographically valid cookie is proof of token possession, NOT proof
    // that the backing User is still registered/active. Give proofed traffic a
    // generous pre-auth safety ceiling so normal page fan-out is untouched, but
    // a stale/stolen valid JWT can no longer drive unlimited Mongo auth reads.
    proofedPreAuth: [
      { name: 'burst', max: positiveEnvInt('API_PROOFED_PREAUTH_BURST_MAX', 80), windowMs: positiveEnvInt('API_PROOFED_PREAUTH_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_PROOFED_PREAUTH_SUSTAINED_MAX', 600), windowMs: positiveEnvInt('API_PROOFED_PREAUTH_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    // Once authoritative auth rejects a signed proof (removed/unregistered,
    // blocked, revoked session, CSRF/mismatch), subsequent abuse is throttled
    // much more aggressively. We key both by proof identity and client IP so
    // neither IP rotation nor cookie rotation gives an unlimited bypass.
    rejectedProof: [
      { name: 'burst', max: positiveEnvInt('API_REJECTED_PROOF_BURST_MAX', 4), windowMs: positiveEnvInt('API_REJECTED_PROOF_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_REJECTED_PROOF_SUSTAINED_MAX', 12), windowMs: positiveEnvInt('API_REJECTED_PROOF_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    rejectedProofIp: [
      { name: 'burst', max: positiveEnvInt('API_REJECTED_PROOF_IP_BURST_MAX', 8), windowMs: positiveEnvInt('API_REJECTED_PROOF_IP_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_REJECTED_PROOF_IP_SUSTAINED_MAX', 24), windowMs: positiveEnvInt('API_REJECTED_PROOF_IP_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    // This is a broad secondary ceiling for anonymous requests whose reported
    // client IP differs from the ingress-facing hop. It makes casual XFF rotation
    // less useful without treating a shared Cloudflare/hosting hop like one user.
    ingressAnonymous: [
      { name: 'burst', max: positiveEnvInt('API_ANON_INGRESS_BURST_MAX', 600), windowMs: positiveEnvInt('API_ANON_INGRESS_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_ANON_INGRESS_SUSTAINED_MAX', 3_000), windowMs: positiveEnvInt('API_ANON_INGRESS_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
  };
}

/**
 * Cheap cryptographic proof only. This intentionally does NOT query MongoDB and
 * does not decide registration/role/account state. A valid JWT therefore gets a
 * separate pre-auth ceiling instead of an unlimited bypass.
 */
function hasValidFirstPartySession(req) {
  return Boolean(readContextSessionProof(req)?.session);
}

function proofIdentity(proof) {
  const kind = String(proof?.kind || 'unknown');
  const telegramId = String(proof?.session?.telegramId || 'unknown');
  return `${kind}:${telegramId}`;
}

async function consumeRejectedFirstPartySession(req, proof = readContextSessionProof(req), policies = defaultPolicies()) {
  if (!proof?.session) return { limited: false, retryAfterMs: 0 };

  const network = getClientNetworkIdentity(req);
  const byProof = await consumeRateLimit({
    namespace: 'api-abuse:rejected-proof',
    identity: proofIdentity(proof),
    windows: policies.rejectedProof,
  });
  const byIp = await consumeRateLimit({
    namespace: 'api-abuse:rejected-proof-ip',
    identity: network.clientIp,
    windows: policies.rejectedProofIp,
  });

  return {
    limited: byProof.limited || byIp.limited,
    retryAfterMs: Math.max(byProof.retryAfterMs || 0, byIp.retryAfterMs || 0),
    proof: byProof,
    ip: byIp,
  };
}

function setRetryAfter(res, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000));
  res.setHeader('Retry-After', String(seconds));
  return seconds;
}

function createApiAbuseGuard({ isAnonymousEntryPath = isAnonymousEntryApiPath, policies = defaultPolicies() } = {}) {
  if (typeof isAnonymousEntryPath !== 'function') throw new Error('isAnonymousEntryPath must be a function');

  return async function apiAbuseGuard(req, res, next) {
    try {
      const pathname = String(req?.path || '');
      if (!pathname.startsWith('/api')) return next();
      if (String(req?.method || '').toUpperCase() === 'OPTIONS') return next();

      // The dedicated print service has its own machine credential. Normal app
      // session proofs are NOT an unlimited bypass: before Mongo-backed auth we
      // apply a deliberately generous safety ceiling. This keeps legitimate
      // initial fan-out/polling intact while bounding stale/stolen JWT abuse.
      if (hasValidPrintAgentToken(req)) return next();

      const network = getClientNetworkIdentity(req);
      const proof = readContextSessionProof(req);
      if (proof?.session) {
        const proofed = await consumeRateLimit({
          namespace: 'api-abuse:proofed-preauth',
          identity: proofIdentity(proof),
          windows: policies.proofedPreAuth,
        });
        if (proofed.limited) {
          const retryAfterSeconds = setRetryAfter(res, proofed.retryAfterMs);
          return next(appError('api_rate_limited', { retryAfterSeconds }));
        }
        return next();
      }

      const entryPath = isAnonymousEntryPath(pathname);
      const primaryPolicy = entryPath ? policies.entryAnonymous : policies.protectedAnonymous;
      const primaryScope = entryPath ? 'anonymous-entry' : 'anonymous-protected';

      const primary = await consumeRateLimit({
        namespace: `api-abuse:${primaryScope}`,
        identity: network.clientIp,
        windows: primaryPolicy,
      });
      if (primary.limited) {
        const retryAfterSeconds = setRetryAfter(res, primary.retryAfterMs);
        return next(appError('api_rate_limited', { retryAfterSeconds }));
      }

      // Only anonymous traffic pays for the secondary ingress bucket, and only
      // when it provides an independent signal. Authenticated requests therefore
      // incur zero Redis work in this middleware.
      if (network.ingressIp && network.ingressIp !== network.clientIp) {
        const ingress = await consumeRateLimit({
          namespace: 'api-abuse:anonymous-ingress',
          identity: network.ingressIp,
          windows: policies.ingressAnonymous,
        });
        if (ingress.limited) {
          const retryAfterSeconds = setRetryAfter(res, ingress.retryAfterMs);
          return next(appError('api_rate_limited', { retryAfterSeconds }));
        }
      }

      return next();
    } catch (_) {
      // Abuse protection must degrade to the existing auth boundary, not turn a
      // Redis/configuration hiccup into an ERP outage. rateLimitCore already has
      // a local fallback; this is the final fail-open safety net.
      return next();
    }
  };
}

module.exports = {
  createApiAbuseGuard,
  defaultPolicies,
  hasValidFirstPartySession,
  hasValidPrintAgentToken,
  consumeRejectedFirstPartySession,
};
