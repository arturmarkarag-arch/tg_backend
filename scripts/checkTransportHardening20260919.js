'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const middleware = fs.readFileSync(
  path.join(root, 'middleware', 'securityResponseHeaders.js'),
  'utf8',
);

function must(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const hstsMatch = middleware.match(/const HSTS_VALUE = '([^']+)'/);
const hstsValue = hstsMatch ? hstsMatch[1] : '';

must(app.includes("app.use(securityResponseHeaders)"), 'transport middleware mounted');
must(
  app.indexOf("app.use(securityResponseHeaders)") < app.indexOf("app.use(cors(expressCorsOptions))"),
  'transport middleware runs before CORS',
);
must(middleware.includes("'X-Content-Type-Options', 'nosniff'"), 'nosniff configured');
must(middleware.includes("'Strict-Transport-Security', HSTS_VALUE"), 'HSTS configured');
must(hstsValue === 'max-age=31536000', 'HSTS max-age is exactly one year');
must(!hstsValue.includes('includeSubDomains'), 'includeSubDomains is not enabled yet');
must(!hstsValue.includes('preload'), 'HSTS preload is not enabled yet');
must(
  app.includes("app.get('/api/health', (req, res) => {\n  res.set('Cache-Control', 'no-store');"),
  '/api/health is no-store',
);
must(
  app.includes("app.get('/api/maintenance', (req, res) => {\n  res.set('Cache-Control', 'no-store');"),
  '/api/maintenance is no-store',
);

if (process.exitCode) process.exit(process.exitCode);
console.log('Transport hardening static gate: PASS');
