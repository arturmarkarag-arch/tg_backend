'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { capabilityMatrix, ALLEGRO_SCOPE } = require('../services/allegroCapabilities');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

const accounts = read('services/allegroAccounts.js');
const oauth = read('services/allegroOAuth.js');
const orders = read('services/allegroOrders.js');
const scheduler = read('services/allegroOrderScheduler.js');
const syncModel = read('models/AllegroOrderSyncState.js');
const route = read('routes/allegro.js');
const errors = read('utils/errors.js');

check('scope capability matrix distinguishes order and shipment permissions', () => {
  const matrix = capabilityMatrix([ALLEGRO_SCOPE.PROFILE_READ, ALLEGRO_SCOPE.ORDERS_READ]);
  assert.equal(matrix.scopesKnown, true);
  assert.equal(matrix.capabilities.ordersRead, true);
  assert.equal(matrix.capabilities.ordersWrite, false);
  assert.equal(matrix.capabilities.shipmentsRead, false);
  assert.equal(matrix.orderIngestReady, true);
});

check('unknown scope metadata stays unknown rather than pretending the account is invalid', () => {
  const matrix = capabilityMatrix([]);
  assert.equal(matrix.scopesKnown, false);
  assert.equal(matrix.orderIngestReady, null);
});

check('public account exposes sanitized capability and token revision diagnostics only', () => {
  assert(accounts.includes('capabilities: scopeState.capabilities'));
  assert(accounts.includes('missingOrderIngestScopes'));
  assert(accounts.includes('tokenRevision: Math.max(0, Number(row.tokenRevision) || 0)'));
  assert(!accounts.includes('accessToken:'));
  assert(!accounts.includes('refreshToken:'));
});

check('known missing orders:read prevents enabling direct order ingestion', () => {
  assert(accounts.includes("allegro_account_missing_required_scopes"));
  assert(accounts.includes('scopeState.scopesKnown && scopeState.orderIngestReady === false'));
  assert(errors.includes('allegro_account_missing_required_scopes'));
});

check('OAuth rotation fails closed if a previously active seller loses orders:read', () => {
  assert(oauth.includes('nextSet.enabled = false'));
  assert(oauth.includes('scopeState.scopesKnown && scopeState.orderIngestReady === false'));
  assert(scheduler.includes('account.orderIngestReady !== false'));
});

check('admin can force a real OAuth refresh without receiving tokens', () => {
  assert(oauth.includes('async function forceRefreshAllegroAccessToken'));
  assert(oauth.includes('forceRefresh: true'));
  assert(oauth.includes('rejectedTokenRevision: null'));
  assert(route.includes("router.post('/accounts/:accountId/token-refresh'"));
  const refreshRoute = route.slice(route.indexOf("router.post('/accounts/:accountId/token-refresh'"), route.indexOf("router.post('/accounts/:accountId/orders/rebootstrap'"));
  assert(!refreshRoute.includes('accessToken'));
  assert(!refreshRoute.includes('refreshToken'));
});

check('scheduler retry cooldown is durable across process restarts', () => {
  assert(syncModel.includes('nextRetryAt'));
  assert(scheduler.includes('getAllegroOrderSyncStates'));
  assert(scheduler.includes('setAllegroOrderRetryAt'));
  assert(!scheduler.includes('retryAfterByAccount = new Map'));
});

check('sync health persists actionable failure metadata', () => {
  for (const field of ['lastErrorCode', 'lastErrorTraceId', 'lastErrorHttpStatus', 'consecutiveFailures']) {
    assert(syncModel.includes(field), field);
    assert(orders.includes(field), field);
  }
  assert(orders.includes("health = 'backoff'"));
  assert(orders.includes("health = 'stale'"));
  assert(orders.includes("health = 'degraded'"));
  assert(orders.includes("health = 'healthy'"));
});

check('successful sync clears old retry and diagnostic failure state', () => {
  assert(orders.includes('nextRetryAt: null'));
  assert(orders.includes("lastErrorCode: ''"));
  assert(orders.includes("lastErrorTraceId: ''"));
  assert(orders.includes('lastErrorHttpStatus: null'));
});

check('manual recovery rebuilds local cache without mutating Allegro', () => {
  assert(orders.includes('async function forceRebootstrapAllegroAccount'));
  assert(orders.includes('state?.initialized === true'));
  assert(orders.includes("bootstrapState: 'complete'"));
  assert(orders.includes('const result = await bootstrapAccount(account, state)'));
  assert(route.includes("router.post('/accounts/:accountId/orders/rebootstrap'"));
});

check('rebootstrap and ordinary sync share the same per-account distributed lock', () => {
  const lockLiteral = '`allegro-order-sync:${id}`';
  assert(orders.split(lockLiteral).length >= 3);
  assert(orders.includes('ttlMs: ORDER_SYNC_LOCK_TTL_MS'));
});

console.log(`\nAllegro Stage 4.3 live-hardening backend contract: ${pass}/${pass} PASS`);
