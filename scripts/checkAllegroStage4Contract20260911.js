'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

const service = read('services/allegroOrders.js');
const scheduler = read('services/allegroOrderScheduler.js');
const syncModel = read('models/AllegroOrderSyncState.js');
const indexModel = read('models/AllegroOrderIndex.js');
const route = read('routes/allegro.js');
const startup = read('index.js');
const errors = read('utils/errors.js');

check('each Allegro account owns an independent durable event cursor', () => {
  assert(syncModel.includes('accountId: { type: String, required: true'));
  assert(syncModel.includes('unique: true'));
  assert(syncModel.includes('cursorEventId'));
  assert(syncModel.includes('bootstrapBarrierEventId'));
  assert(!syncModel.includes('baseLinker'));
});

check('bootstrap sets an event barrier before reading the active order snapshot', () => {
  const barrier = service.indexOf('const barrier = await fetchEventStats(account.accountId)');
  const snapshot = service.indexOf('const rows = await fetchBootstrapActiveOrders(account)');
  assert(barrier >= 0 && snapshot > barrier);
  assert(service.includes("path: '/order/event-stats'"));
});

check('bootstrap imports only ready seller-managed orders and respects Allegro paging cap', () => {
  assert(service.includes("status: 'READY_FOR_PROCESSING'"));
  assert(service.includes("'fulfillment.provider.id': 'SELLER'"));
  assert(service.includes("'fulfillment.status': ACTIVE_FULFILLMENT_STATUSES"));
  assert(service.includes('limit: BOOTSTRAP_PAGE_SIZE'));
  assert(service.includes('offset >= 10_000'));
  assert(!service.includes('for (const fulfillmentStatus of ACTIVE_FULFILLMENT_STATUSES)'));
});

check('One Fulfillment never enters the warehouse projection', () => {
  assert(service.includes("if (provider !== 'SELLER')"));
  assert(service.includes('AllegroOrderIndex.deleteOne'));
  assert(indexModel.includes('fulfillmentProviderId'));
});

check('journal cursor advances only after exact detail reconciliation succeeds', () => {
  const refresh = service.indexOf('const refreshed = await refreshCheckoutForms');
  const cursor = service.indexOf('cursorEventId = clean(last?.id');
  assert(refresh >= 0 && cursor > refresh);
  assert(service.includes("path: '/order/events'"));
  assert(service.includes('from: cursorEventId'));
  assert(service.includes('MAX_DETAIL_REFRESHES_PER_TICK'));
});

check('events are not trusted as the final order state', () => {
  assert(service.includes("path: `/order/checkout-forms/${encodeURIComponent(checkoutFormId)}`"));
  assert(service.includes('READY_FOR_PROCESSING'));
  assert(service.includes('BUYER_CANCELLED'));
  assert(service.includes('AUTO_CANCELLED'));
  assert(service.includes('FULFILLMENT_STATUS_CHANGED'));
});

check('merged checkout forms are reconciled by treating detail 404 as stale projection', () => {
  assert(service.includes('Number(error?.status) === 404'));
  assert(service.includes('upstreamMissing: true'));
  assert(service.includes('Merged purchases'));
});

check('local order index intentionally excludes buyer/address/payment/invoice/raw payloads', () => {
  assert(indexModel.includes('does NOT mirror'));
  for (const forbidden of ['buyer:', 'address:', 'payment:', 'invoice:', 'rawPayload:', 'rawOrder:']) {
    assert(!indexModel.includes(forbidden), `forbidden persisted field: ${forbidden}`);
  }
  assert(indexModel.includes('preview'));
  assert(indexModel.includes('searchText'));
});

check('normal list/search/pagination routes read Mongo only and never Allegro upstream', () => {
  assert(route.includes("router.get('/orders'"));
  assert(route.includes('getAllegroOrderPage'));
  const pageFn = service.slice(service.indexOf('async function getAllegroOrderPage'), service.indexOf('async function getLocalAllegroOrder'));
  assert(pageFn.includes('AllegroOrderIndex'));
  assert(!pageFn.includes('allegroRequest('));
});

check('manual sync is explicit admin-only functionality rather than a GET side effect', () => {
  assert(route.includes("router.post('/sync'"));
  assert(route.includes("router.use(requireTelegramRole('admin'))"));
  assert(!route.includes("router.get('/orders', asyncHandler(async (req, res) => {\n  const result = await sync"));
});

check('scheduler polls enabled connected accounts with per-account leadership/backoff and no cross-shop head-of-line blocking', () => {
  assert(scheduler.includes("account.authState === 'connected'"));
  assert(scheduler.includes("`allegro-order-poll:${accountId}`"));
  assert(scheduler.includes('runAsSchedulerLeader'));
  assert(scheduler.includes('retryAfterByAccount'));
  assert(scheduler.includes('ALLEGRO_ORDER_POLL_MS'));
  assert(scheduler.includes('Promise.all(enabled.map(async (account) =>'));
});

check('post-bootstrap polling errors keep the completed bootstrap state intact', () => {
  assert(service.includes('if (!current?.initialized) setFields.bootstrapState = \'error\''));
  assert(!service.includes("$set: { lastPollAt: now, lastError: message, bootstrapState: 'error' }"));
});

check('a long service outage re-bootstrap protects the 60-day Allegro event retention boundary', () => {
  assert(service.includes('ALLEGRO_ORDER_REBOOTSTRAP_AFTER_DAYS'));
  assert(service.includes('JOURNAL_OUTAGE_REBOOTSTRAP_MS'));
  assert(service.includes('ORDER_SYNC_LOCK_TTL_MS'));
  assert(service.includes('ttlMs: ORDER_SYNC_LOCK_TTL_MS'));
  assert(service.includes('staleAfterOutage'));
  assert(service.includes('Date.now() - lastSuccessAt.getTime()'));
});

check('Stage 4 startup syncs both order indexes and starts the scheduler after DB readiness', () => {
  assert(startup.includes("require('./models/AllegroOrderSyncState').syncIndexes()"));
  assert(startup.includes("require('./models/AllegroOrderIndex').syncIndexes()"));
  assert(startup.includes('startAllegroOrderScheduler'));
  assert(route.includes('stage: 4'));
  assert(errors.includes('allegro_order_bootstrap_too_large'));
  assert(errors.includes('allegro_order_not_found'));
});

console.log(`\nAllegro Stage 4 backend contract: ${pass}/${pass} PASS`);
