'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-abuse-guard-test-secret';

const fs = require('fs');
const path = require('path');
const { createApiAbuseGuard, consumeRejectedFirstPartySession, defaultPolicies } = require('../middleware/apiAbuseGuard');
const { resetLocalRateLimitStateForTests } = require('../middleware/rateLimitCore');
const { signSession } = require('../utils/jwt');
const { SESSION_COOKIE_NAME } = require('../utils/sessionCookie');
const { indexOrThrow } = require('./helpers/sourceContract');

function request({
  path: pathname = '/api/private',
  method = 'GET',
  ip = '203.0.113.10',
  headers = {},
} = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  return {
    path: pathname,
    method,
    headers: normalizedHeaders,
    socket: { remoteAddress: ip },
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
}

function response() {
  const headers = Object.create(null);
  return {
    headers,
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
  };
}

function run(middleware, req) {
  const res = response();
  return new Promise((resolve) => {
    middleware(req, res, (err) => resolve({ err: err || null, res }));
  });
}

const testPolicies = {
  protectedAnonymous: [
    { name: 'burst', max: 2, windowMs: 60_000 },
    { name: 'sustained', max: 10, windowMs: 60_000 },
  ],
  entryAnonymous: [
    { name: 'burst', max: 3, windowMs: 60_000 },
    { name: 'sustained', max: 10, windowMs: 60_000 },
  ],
  proofedPreAuth: [
    { name: 'burst', max: 100, windowMs: 60_000 },
    { name: 'sustained', max: 100, windowMs: 60_000 },
  ],
  rejectedProof: [
    { name: 'burst', max: 2, windowMs: 60_000 },
    { name: 'sustained', max: 10, windowMs: 60_000 },
  ],
  rejectedProofIp: [
    { name: 'burst', max: 4, windowMs: 60_000 },
    { name: 'sustained', max: 10, windowMs: 60_000 },
  ],
  ingressAnonymous: [
    { name: 'burst', max: 100, windowMs: 60_000 },
    { name: 'sustained', max: 100, windowMs: 60_000 },
  ],
};

function makeGuard() {
  return createApiAbuseGuard({
    isAnonymousEntryPath: (pathname) => pathname === '/api/public',
    policies: testPolicies,
  });
}

describe('API anonymous abuse guard', () => {
  beforeEach(() => {
    resetLocalRateLimitStateForTests();
    delete process.env.BASELINKER_PRINT_AGENT_TOKEN;
  });

  it('cuts repeated anonymous requests to protected API before route/auth work', async () => {
    const guard = makeGuard();
    expect((await run(guard, request())).err).toBe(null);
    expect((await run(guard, request())).err).toBe(null);

    const blocked = await run(guard, request());
    expect(blocked.err?.code).toBe('api_rate_limited');
    expect(blocked.err?.status).toBe(429);
    expect(Number(blocked.res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('gives explicit auth/check entry endpoints a separate, larger anonymous budget', async () => {
    const guard = makeGuard();
    for (let i = 0; i < 3; i += 1) {
      expect((await run(guard, request({ path: '/api/public' }))).err).toBe(null);
    }
    expect((await run(guard, request({ path: '/api/public' }))).err?.code).toBe('api_rate_limited');
  });

  it('gives a valid first-party proof a generous but finite pre-auth safety ceiling', async () => {
    const guard = makeGuard();
    const token = signSession('123456789', 0);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

    for (let i = 0; i < 20; i += 1) {
      const result = await run(guard, request({ headers: { cookie } }));
      expect(result.err).toBe(null);
    }

    const tight = createApiAbuseGuard({
      isAnonymousEntryPath: () => false,
      policies: {
        ...testPolicies,
        proofedPreAuth: [
          { name: 'burst', max: 2, windowMs: 60_000 },
          { name: 'sustained', max: 10, windowMs: 60_000 },
        ],
      },
    });
    resetLocalRateLimitStateForTests();
    expect((await run(tight, request({ headers: { cookie } }))).err).toBe(null);
    expect((await run(tight, request({ headers: { cookie } }))).err).toBe(null);
    expect((await run(tight, request({ headers: { cookie } }))).err?.code).toBe('api_rate_limited');
  });

  it('rate-limits a cryptographically valid proof after authoritative auth rejects it', async () => {
    const token = signSession('not-registered', 0);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
    const req = request({ headers: { cookie } });
    const proof = { kind: 'browser', session: { telegramId: 'not-registered', sessionVersion: 0 } };

    expect((await consumeRejectedFirstPartySession(req, proof, testPolicies)).limited).toBe(false);
    expect((await consumeRejectedFirstPartySession(req, proof, testPolicies)).limited).toBe(false);
    const blocked = await consumeRejectedFirstPartySession(req, proof, testPolicies);
    expect(blocked.limited).toBe(true);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('ships much tighter defaults for anonymous protected paths than auth-entry paths', () => {
    const policies = defaultPolicies();
    expect(policies.protectedAnonymous[0]).toMatchObject({ max: 6, windowMs: 10_000 });
    expect(policies.protectedAnonymous[1]).toMatchObject({ max: 24, windowMs: 5 * 60_000 });
    expect(policies.entryAnonymous[0].max).toBeGreaterThan(policies.protectedAnonymous[0].max);
    expect(policies.rejectedProof[0]).toMatchObject({ max: 4, windowMs: 10_000 });
  });

  it('treats a forged/invalid session cookie as anonymous', async () => {
    const guard = makeGuard();
    const cookie = `${SESSION_COOKIE_NAME}=not-a-valid-session`;
    expect((await run(guard, request({ headers: { cookie } }))).err).toBe(null);
    expect((await run(guard, request({ headers: { cookie } }))).err).toBe(null);
    expect((await run(guard, request({ headers: { cookie } }))).err?.code).toBe('api_rate_limited');
  });

  it('does not throttle the Print Agent when its dedicated service token is valid', async () => {
    process.env.BASELINKER_PRINT_AGENT_TOKEN = 'print-agent-test-secret';
    const guard = makeGuard();

    for (let i = 0; i < 20; i += 1) {
      const result = await run(guard, request({
        path: '/api/print-agent/jobs/claim',
        method: 'POST',
        headers: { 'x-print-agent-token': 'print-agent-test-secret' },
      }));
      expect(result.err).toBe(null);
    }
  });

  it('leaves non-API traffic and CORS preflight outside this guard', async () => {
    const guard = makeGuard();
    for (let i = 0; i < 10; i += 1) {
      expect((await run(guard, request({ path: '/not-api' }))).err).toBe(null);
      expect((await run(guard, request({ method: 'OPTIONS' }))).err).toBe(null);
    }
  });

  it('does not let Telegram client diagnostics consume the normal anonymous entry budget', async () => {
    const guard = makeGuard();
    for (let i = 0; i < 10; i += 1) {
      expect((await run(guard, request({ path: '/api/v1/auth/telegram/diagnostic', method: 'POST' }))).err).toBe(null);
    }

    // The real auth entry bucket is still untouched by those diagnostic calls.
    for (let i = 0; i < 3; i += 1) {
      expect((await run(guard, request({ path: '/api/public' }))).err).toBe(null);
    }
    expect((await run(guard, request({ path: '/api/public' }))).err?.code).toBe('api_rate_limited');
  });

  it('is mounted before JSON parsing and before the authoritative API auth gate', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const guardIndex = indexOrThrow(appSource, 'app.use(createApiAbuseGuard({ isAnonymousEntryPath: isAnonymousEntryApiPath }))', { label: 'abuse guard mount' });
    const jsonIndex = indexOrThrow(appSource, 'app.use(express.json())', { label: 'JSON parser mount' });
    const authIndex = indexOrThrow(appSource, 'app.use(requireAuthForApi)', { label: 'API auth gate mount' });

    expect(jsonIndex).toBeGreaterThan(guardIndex);
    expect(authIndex).toBeGreaterThan(jsonIndex);

    const authSource = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'telegramAuth.js'), 'utf8');
    expect(authSource).toContain('consumeRejectedFirstPartySession');
    expect(authSource).toContain("appError('not_registered'), sessionProof");
    expect(authSource).toContain("appError('registration_blocked'), sessionProof");
    expect(authSource).toContain("appError('auth_required'), sessionProof");
  });
});
