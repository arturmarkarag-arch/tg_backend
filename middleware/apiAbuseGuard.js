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
    // A legitimate unauthenticated frontend can briefly fan out during bootstrap,
    // so the burst allowance is intentionally not tiny. Sustained anonymous use
    // is much tighter than authenticated traffic.
    protectedAnonymous: [
      { name: 'burst', max: positiveEnvInt('API_ANON_PROTECTED_BURST_MAX', 50), windowMs: positiveEnvInt('API_ANON_PROTECTED_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvInt('API_ANON_PROTECTED_SUSTAINED_MAX', 150), windowMs: positiveEnvInt('API_ANON_PROTECTED_SUSTAINED_WINDOW_MS', 5 * 60_000) },
    ],
    entryAnonymous: [
      { name: 'burst', max: positiveEnvIntCompat('API_ANON_ENTRY_BURST_MAX', 'API_ANON_PUBLIC_BURST_MAX', 80), windowMs: positiveEnvIntCompat('API_ANON_ENTRY_BURST_WINDOW_MS', 'API_ANON_PUBLIC_BURST_WINDOW_MS', 10_000) },
      { name: 'sustained', max: positiveEnvIntCompat('API_ANON_ENTRY_SUSTAINED_MAX', 'API_ANON_PUBLIC_SUSTAINED_MAX', 400), windowMs: positiveEnvIntCompat('API_ANON_ENTRY_SUSTAINED_WINDOW_MS', 'API_ANON_PUBLIC_SUSTAINED_WINDOW_MS', 5 * 60_000) },
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
 * Cheap local proof only. This intentionally does NOT query MongoDB and does
 * not decide authorization/role/account state. It only keeps authenticated
 * first-party sessions out of the anonymous flood budget.
 */
function hasValidFirstPartySession(req) {
  return Boolean(readContextSessionProof(req)?.session);
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

      // Normal signed sessions and the dedicated print service are intentionally
      // not put through this anonymous guard. This keeps initial page fan-out,
      // polling and background refreshes unchanged. Their actual authorization is
      // still enforced later by telegramAuth / requireAgentToken.
      if (hasValidFirstPartySession(req) || hasValidPrintAgentToken(req)) return next();

      const network = getClientNetworkIdentity(req);
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
};
