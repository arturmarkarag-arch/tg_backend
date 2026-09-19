'use strict';

const fs = require('fs');
const path = require('path');
const {
  HSTS_VALUE,
  securityResponseHeaders,
} = require('../middleware/securityResponseHeaders');

function response() {
  const headers = Object.create(null);
  return {
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
  };
}

function runWithNodeEnv(nodeEnv) {
  const previous = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;

  try {
    const res = response();
    let nextCalled = false;
    securityResponseHeaders({}, res, () => { nextCalled = true; });
    return { res, nextCalled };
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe('transport security headers', () => {
  it('sets nosniff on every environment', () => {
    const { res, nextCalled } = runWithNodeEnv('test');
    expect(nextCalled).toBe(true);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets one-year HSTS in production without includeSubDomains/preload', () => {
    const { res } = runWithNodeEnv('production');
    expect(res.headers['strict-transport-security']).toBe(HSTS_VALUE);
    expect(HSTS_VALUE).toBe('max-age=31536000');
    expect(HSTS_VALUE).not.toContain('includeSubDomains');
    expect(HSTS_VALUE).not.toContain('preload');
  });

  it('does not force HSTS in local/test environments', () => {
    const { res } = runWithNodeEnv('test');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('mounts transport headers before CORS and auth/rate-limit boundaries', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const headersIndex = source.indexOf('app.use(securityResponseHeaders)');
    const corsIndex = source.indexOf('app.use(cors(expressCorsOptions))');
    const abuseIndex = source.indexOf('app.use(createApiAbuseGuard');
    const boundaryIndex = source.indexOf('app.use(createStrictAccessBoundary())');

    expect(headersIndex).toBeGreaterThanOrEqual(0);
    expect(corsIndex).toBeGreaterThan(headersIndex);
    expect(abuseIndex).toBeGreaterThan(headersIndex);
    expect(boundaryIndex).toBeGreaterThan(headersIndex);
  });

  it('marks live health/maintenance state as no-store', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    expect(source).toContain("app.get('/api/health', (req, res) => {\n  res.set('Cache-Control', 'no-store');");
    expect(source).toContain("app.get('/api/maintenance', (req, res) => {\n  res.set('Cache-Control', 'no-store');");
  });
});
