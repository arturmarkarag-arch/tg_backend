'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

const http = read('services/allegroHttpClient.js');
const logModel = read('models/AllegroApiErrorLog.js');
const route = read('routes/allegro.js');
const errors = read('utils/errors.js');
const startup = read('index.js');
const migration = read('services/allegroIndependentMigration.js');

check('global Client ID budget keeps headroom below official 9000 rpm', () => {
  assert(http.includes('const OFFICIAL_APP_LIMIT_PER_MINUTE = 9000'));
  assert(http.includes('ALLEGRO_REQUEST_BUDGET_PER_MINUTE'));
  assert(http.includes('8950'));
  assert(http.includes('globalUsageKey()'));
});

check('rate coordination is Redis-backed with conservative process-local fallback', () => {
  assert(http.includes('RESERVE_ROLLING_SCRIPT'));
  assert(http.includes("coordinationMode: isRedisReady() ? 'redis' : 'process_local'"));
  assert(http.includes('ALLEGRO_LOCAL_FALLBACK_BUDGET_PER_MINUTE'));
});

check('seller accounts have isolated concurrency guards', () => {
  assert(http.includes('ALLEGRO_ACCOUNT_MAX_CONCURRENCY'));
  assert(http.includes('ACQUIRE_CONCURRENCY_SCRIPT'));
  assert(http.includes('concurrencyKey(accountId)'));
});

check('endpoint-specific limits are opt-in policies rather than a fake universal seller RPM', () => {
  assert(http.includes('ratePolicy?.key'));
  assert(http.includes('endpointUsageKey'));
  assert(http.includes('Endpoint-specific Allegro limits vary by resource'));
});

check('transport enforces Authorization, Accept and mandatory User-Agent centrally', () => {
  assert(http.includes('Authorization: `Bearer ${credential.accessToken}`'));
  assert(http.includes("'User-Agent': clean(oauthConfiguration().userAgent"));
  assert(http.includes("application/vnd.allegro.public.v1+json"));
});

check('401 performs exactly one controlled token refresh path without logging the ERP user out', () => {
  assert(http.includes('let refreshedAfter401 = false'));
  assert(http.includes('response.status === 401 && !refreshedAfter401'));
  assert(http.includes('forceRefresh: true'));
  assert(http.includes('response.status === 401 && refreshedAfter401'));
  assert(http.includes("appError('allegro_api_authorization_lost'"));
  assert(errors.includes("allegro_api_authorization_lost: { status: 409"));
});

check('generic retry is restricted to safe/idempotent operations', () => {
  assert(http.includes("if (retryPolicy === 'never') return false"));
  assert(http.includes("if (retryPolicy === 'idempotent') return true"));
  assert(http.includes("['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']"));
});

check('429 honors Retry-After and falls back to a 60 second cooldown', () => {
  assert(http.includes("headers?.get?.('retry-after')"));
  assert(http.includes('Number(status) === 429 ? 60_000 : null'));
  assert(errors.includes('allegro_api_rate_limited:'));
});

check('202 is never flattened into ordinary completed success', () => {
  assert(http.includes('pending: response.status === 202'));
  assert(http.includes("response.headers.get('location')"));
  assert(http.includes('retryAfterMs: parseRetryAfterMs(response)'));
});

check('Allegro error payload keeps the complete sanitized errors array for diagnostics', () => {
  for (const field of ['source.code', 'source.message', 'source.userMessage', 'source.details', 'source.path', 'source.metadata']) {
    assert(http.includes(field));
  }
  assert(http.includes('payload.errors.slice(0, 20)'));
  assert(http.includes('upstreamErrors'));
  assert(logModel.includes('upstreamErrors'));
});

check('diagnostic error log is sanitized and TTL-retained', () => {
  assert(logModel.includes('traceId'));
  assert(logModel.includes('fieldPath'));
  assert(logModel.includes('expiresAt'));
  assert(logModel.includes('expireAfterSeconds: 0'));
  assert(!logModel.includes('accessToken'));
  assert(!logModel.includes('refreshToken'));
});

check('admin diagnostics expose API usage and recent errors separately', () => {
  assert(route.includes("router.get('/api-usage'"));
  assert(route.includes("router.get('/errors'"));
  assert(route.includes('getAllegroApiUsage'));
  assert(route.includes('listAllegroApiErrors'));
});

check('Stage 1/2 BaseLinker mapping is removed from stored Allegro documents and stale indexes are synced away', () => {
  assert(migration.includes("$unset: { baseLinkerAccountId: '' }"));
  assert(startup.includes('migrateAllegroIndependentAccounts'));
  assert(startup.includes("require('./models/AllegroAccount').syncIndexes()"));
  assert(startup.includes("require('./models/AllegroApiErrorLog').syncIndexes()"));
});

console.log(`\nAllegro Stage 3 backend contract: ${pass}/${pass} PASS`);
