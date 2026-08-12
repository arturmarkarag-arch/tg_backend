'use strict';

const path = require('path');

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('security boundaries', () => {
  it('production CORS falls back to WEB_APP_URL instead of allowing every origin', () => {
    withEnv({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: undefined,
      WEB_APP_URL: 'https://app.example.test/path',
    }, () => {
      vi.resetModules();
      const { getAllowedOrigins, corsOrigin } = require('../utils/corsOptions');
      expect(getAllowedOrigins()).toEqual(['https://app.example.test']);

      let allowed = null;
      corsOrigin('https://evil.example', (err, ok) => { allowed = { err, ok }; });
      expect(allowed.err).toBeInstanceOf(Error);

      corsOrigin('https://app.example.test', (err, ok) => { allowed = { err, ok }; });
      expect(allowed.err).toBeNull();
      expect(allowed.ok).toBe(true);
    });
  });

  it('production CORS fails closed for browser origins when no allowlist/fallback exists', () => {
    withEnv({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: undefined, WEB_APP_URL: undefined }, () => {
      vi.resetModules();
      const { getAllowedOrigins, corsOrigin } = require('../utils/corsOptions');
      expect(getAllowedOrigins()).toEqual([]);

      let result = null;
      corsOrigin('https://evil.example', (err, ok) => { result = { err, ok }; });
      expect(result.err).toBeInstanceOf(Error);

      corsOrigin(undefined, (err, ok) => { result = { err, ok }; });
      expect(result.err).toBeNull();
      expect(result.ok).toBe(true);
    });
  });

  it('warehouse test API is opt-in and never part of the public API allowlist', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source).toContain("process.env.ENABLE_TEST_API === 'true'");
    expect(source).not.toContain("publicApiPaths.push(/^\\/api\\/warehouse-test");
    expect(source).toContain("app.use('/api/warehouse-test', requireTelegramRole('admin')");
  });

  it('does not advertise the backend stack in every response', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source).toContain("app.disable('x-powered-by')");
  });

  it('bot status is admin-only, while public health does not reveal environment', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source).not.toContain('/^\\/api\\/bot-status$/');
    expect(source).toContain("app.get('/api/bot-status', requireTelegramRole('admin')");
    expect(source).not.toContain("environment: process.env.NODE_ENV");
  });

  it('does not expose raw Mongoose validation details to sellers/public callers', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'errors.js'), 'utf8');
    expect(source).toContain("if (['admin', 'warehouse'].includes(req?.telegramUser?.role)) payload.details = err.message");
    expect(source).not.toContain("message: t('validation_failed'),\n      details: err.message");
  });

  it('keeps high-risk users mutations admin-only at router level', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
    expect(source).toContain('router.use(telegramAuth)');
    expect(source).toContain("router.use(requireTelegramRole('admin'))");
  });

  it('does not expose raw Gemini/Atlas implementation errors to sellers', () => {
    const source = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'visionSearch.js'), 'utf8');
    expect(source).toContain('function staffTechnicalDetails');
    expect(source).toContain("['admin', 'warehouse'].includes(req.telegramUser?.role)");
    expect(source).not.toContain("json({ error: 'gemini_api_error', message: err.message })");
    expect(source).not.toContain('перевір Atlas-індекс');
  });

});
