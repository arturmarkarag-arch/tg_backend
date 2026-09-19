'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'strict-access-boundary-test-secret';

const fs = require('fs');
const path = require('path');
const {
  createStrictAccessBoundary,
  isAnonymousEntryApiPath,
  isTelegramProofApiPath,
  isContextProofApiPath,
  isBrowserProofApiPath,
  isServiceTokenApiPath,
} = require('../middleware/accessBoundary');
const { signSession, signTelegramSession } = require('../utils/jwt');
const {
  SESSION_COOKIE_NAME,
  TELEGRAM_SESSION_COOKIE_NAME,
} = require('../utils/sessionCookie');
const { indexOrThrow } = require('./helpers/sourceContract');

function fakeRequest({
  pathname = '/api/products',
  method = 'GET',
  headers = {},
} = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  return {
    path: pathname,
    method,
    headers: normalized,
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
}

function run(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve(err || null));
  });
}

function browserCookie(telegramId = '123456789') {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSession(telegramId, 0))}`;
}

function telegramCookie(telegramId = '123456789') {
  return `${TELEGRAM_SESSION_COOKIE_NAME}=${encodeURIComponent(signTelegramSession(telegramId))}`;
}

describe('strict server access boundary', () => {
  it('keeps the anonymous entry surface exact and narrow', () => {
    expect(isAnonymousEntryApiPath('/api/v1/auth/config')).toBe(true);
    expect(isAnonymousEntryApiPath('/api/v1/auth/telegram/bootstrap')).toBe(true);
    expect(isAnonymousEntryApiPath('/api/v1/auth/google')).toBe(true);
    expect(isAnonymousEntryApiPath('/api/health')).toBe(true);
    expect(isAnonymousEntryApiPath('/api/allegro/oauth/callback')).toBe(true);

    expect(isAnonymousEntryApiPath('/api/products')).toBe(false);
    expect(isAnonymousEntryApiPath('/api/shops')).toBe(false);
    expect(isAnonymousEntryApiPath('/api/maintenance')).toBe(false);
    expect(isAnonymousEntryApiPath('/api/v1/auth/anything-else')).toBe(false);
    expect(isAnonymousEntryApiPath('/api/v1/telegram/register-requests')).toBe(false);
  });

  it('allows only explicit login/check entries without an existing session', async () => {
    const gate = createStrictAccessBoundary();
    expect(await run(gate, fakeRequest({ pathname: '/api/v1/auth/config' }))).toBe(null);
    expect(await run(gate, fakeRequest({ pathname: '/api/v1/auth/telegram/bootstrap', method: 'POST' }))).toBe(null);
    expect(await run(gate, fakeRequest({ pathname: '/api/health' }))).toBe(null);
  });

  it('rejects anonymous callers from every normal API namespace and unknown server path', async () => {
    const gate = createStrictAccessBoundary();
    for (const pathname of [
      '/api/products',
      '/api/orders',
      '/api/maintenance',
      '/api/admin/users',
      '/api/search-products',
      '/uploads/legacy.jpg',
      '/warehouse-test/index.html',
      '/totally-unknown-path',
    ]) {
      const err = await run(gate, fakeRequest({ pathname }));
      expect(err?.code).toBe('auth_required');
      expect(err?.status).toBe(401);
    }
  });

  it('accepts a valid browser proof for normal server/API paths and rejects a forged cookie', async () => {
    const gate = createStrictAccessBoundary();
    const valid = await run(gate, fakeRequest({
      pathname: '/api/products',
      headers: { cookie: browserCookie() },
    }));
    expect(valid).toBe(null);

    const forged = await run(gate, fakeRequest({
      pathname: '/api/products',
      headers: { cookie: `${SESSION_COOKIE_NAME}=forged` },
    }));
    expect(forged?.code).toBe('auth_required');
  });

  it('requires first-party Telegram proof for pre-registration and registration support routes', async () => {
    const gate = createStrictAccessBoundary();
    for (const pathname of [
      '/api/v1/telegram/validate',
      '/api/v1/telegram/me',
      '/api/v1/telegram/registration-invite',
      '/api/v1/telegram/register-request',
    ]) {
      expect(isTelegramProofApiPath(pathname)).toBe(true);
      const missing = await run(gate, fakeRequest({ pathname, method: 'POST' }));
      expect(missing?.code).toBe('auth_telegram_session_required');

      const allowed = await run(gate, fakeRequest({
        pathname,
        method: 'POST',
        headers: { cookie: telegramCookie() },
      }));
      expect(allowed).toBe(null);
    }
  });

  it('accepts either Telegram or browser proof for registration reference data', async () => {
    const gate = createStrictAccessBoundary();
    for (const pathname of ['/api/shops/cities', '/api/shops/registry']) {
      expect(isContextProofApiPath(pathname)).toBe(true);
      expect(isTelegramProofApiPath(pathname)).toBe(false);

      const anonymous = await run(gate, fakeRequest({ pathname }));
      expect(anonymous?.code).toBe('auth_required');

      const telegram = await run(gate, fakeRequest({
        pathname,
        headers: {
          cookie: telegramCookie(),
          'x-auth-context': 'telegram',
        },
      }));
      expect(telegram).toBe(null);

      const browser = await run(gate, fakeRequest({
        pathname,
        headers: { cookie: browserCookie() },
      }));
      expect(browser).toBe(null);
    }
  });

  it('makes registration reference routes select authoritative auth by transport', () => {
    const middleware = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'registrationReferenceAuth.js'),
      'utf8',
    );
    const shops = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shops.js'), 'utf8');
    expect(middleware).toContain("=== 'telegram'");
    expect(middleware).toContain('telegramIdentity(req, res, next)');
    expect(middleware).toContain('telegramAuth(req, res, next)');
    expect(shops).toContain("router.get('/cities', registrationReferenceAuth");
    expect(shops).toContain("router.get('/registry', registrationReferenceAuth");
  });

  it('requires browser proof for auth/me and logout instead of treating them as public', async () => {
    const gate = createStrictAccessBoundary();
    for (const pathname of ['/api/v1/auth/me', '/api/v1/auth/logout']) {
      expect(isBrowserProofApiPath(pathname)).toBe(true);
      expect((await run(gate, fakeRequest({ pathname })))?.code).toBe('auth_required');
      expect(await run(gate, fakeRequest({ pathname, headers: { cookie: browserCookie() } }))).toBe(null);
    }
  });

  it('requires the dedicated Print Agent service token before body parsing', async () => {
    process.env.BASELINKER_PRINT_AGENT_TOKEN = 'print-agent-secret';
    const gate = createStrictAccessBoundary();
    const pathname = '/api/print-agent/jobs/claim';
    expect(isServiceTokenApiPath(pathname)).toBe(true);

    const missing = await run(gate, fakeRequest({ pathname, method: 'POST' }));
    expect(missing?.code).toBe('print_agent_unauthorized');
    expect(missing?.status).toBe(401);

    const valid = await run(gate, fakeRequest({
      pathname,
      method: 'POST',
      headers: { 'x-print-agent-token': 'print-agent-secret' },
    }));
    expect(valid).toBe(null);
    delete process.env.BASELINKER_PRINT_AGENT_TOKEN;
  });

  it('allows CORS preflight without exposing route data', async () => {
    const gate = createStrictAccessBoundary();
    expect(await run(gate, fakeRequest({ pathname: '/api/products', method: 'OPTIONS' }))).toBe(null);
  });

  it('mounts the strict gate before JSON/static work and keeps machine ingress isolated', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const webhook = indexOrThrow(source, 'app.post(wh.path,', { label: 'webhook mount' });
    const abuse = indexOrThrow(source, 'app.use(createApiAbuseGuard({ isAnonymousEntryPath: isAnonymousEntryApiPath }))', { label: 'abuse guard mount' });
    const strict = indexOrThrow(source, 'app.use(createStrictAccessBoundary())', { label: 'strict boundary mount' });
    const json = indexOrThrow(source, 'app.use(express.json())', { label: 'general JSON parser' });
    const uploads = indexOrThrow(source, "app.use('/uploads', telegramAuth", { label: 'uploads mount' });
    const userAuth = indexOrThrow(source, 'app.use(requireAuthForApi)', { label: 'authoritative user auth mount' });

    expect(webhook).toBeLessThan(abuse);
    expect(abuse).toBeLessThan(strict);
    expect(strict).toBeLessThan(json);
    expect(json).toBeLessThan(uploads);
    expect(uploads).toBeLessThan(userAuth);
    expect(source).toContain("'/warehouse-test',\n    telegramAuth,\n    requireTelegramRole('admin')");
  });
});
