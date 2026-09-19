TRANSPORT HARDENING V1 — changed files only

Changed:
- app.js
- middleware/securityResponseHeaders.js
- tests/transportSecurityHeaders.test.js
- scripts/checkTransportHardening20260919.js

Behavior:
- X-Content-Type-Options: nosniff on all responses.
- Strict-Transport-Security: max-age=31536000 in production only.
- No includeSubDomains/preload yet.
- /api/health and /api/maintenance use Cache-Control: no-store.
- Middleware is mounted before CORS / anonymous rate limit / strict access boundary.

Suggested checks:
node --check app.js
node --check middleware/securityResponseHeaders.js
node --check tests/transportSecurityHeaders.test.js
node scripts/checkTransportHardening20260919.js

Then deploy and repeat only the safe public passive ZAP phase.
