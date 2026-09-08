'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function sliceBetweenOrThrow(src, startText, endText) {
  const start = src.indexOf(startText);
  assert(start >= 0, `missing start anchor: ${startText}`);
  const end = src.indexOf(endText, start + startText.length);
  assert(end > start, `missing end anchor: ${endText}`);
  return src.slice(start, end);
}
let passed = 0;
function check(name, fn) { try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (e) { process.exitCode = 1; console.error(`FAIL ${name}: ${e.message}`); } }

const client = read('services/baseLinkerClient.js');
const index = read('services/baseLinkerOrderIndex.js');
const scheduler = read('services/baseLinkerQueueScheduler.js');
const routes = read('routes/baseLinker.js');
const picking = read('services/baseLinkerPicking.js');
const shift = read('routes/picking.js');
const model = read('models/BaseLinkerOrderIndex.js');

check('rate limit is true rolling 60 seconds, not calendar-minute buckets', () => {
  assert(client.includes("ZREMRANGEBYSCORE"));
  assert(client.includes('USAGE_WINDOW_MS = 60_000'));
  assert(!client.includes('Math.floor(Date.now() / 60_000)'));
});
check('usage is measured at the real BaseLinker transport boundary', () => {
  const call = sliceBetweenOrThrow(client, 'async function callBaseLinkerWithToken', 'async function callBaseLinkerForAccount');
  assert(call.includes("await reserveApiBudget(id, { method: upstreamMethod, usageStage })"));
  assert(call.includes('await fetch(BASELINKER_API_URL'));
});
check('ordinary order list/search/pagination is Mongo-only', () => {
  const block = sliceBetweenOrThrow(index, 'async function getIndexedOrderPage', 'async function getLocalOrderProjection');
  assert(block.includes('READ PATH CONTRACT'));
  assert(block.includes('row?.preview'));
  assert(block.includes('getCachedBaseLinkerProductCatalog(selectedOrders)'));
  assert(!block.includes('fetchBaseLinkerOrders('));
  assert(!block.includes('makeBaseLinkerAccountCaller('));
  assert(!block.includes('syncBaseLinkerOrderIndex('));
});
check('queue persists only sanitized worker preview/search fields, not customer PII', () => {
  assert(model.includes('preview:'));
  assert(model.includes('searchText:'));
  for (const forbidden of ['delivery_fullname', 'delivery_phone', 'phone:', 'email:', 'invoice_fullname']) assert(!model.includes(forbidden));
});
check('warehouse BaseLinker reads are confirmed-only', () => {
  const orders = read('services/baseLinkerOrders.js');
  const retention = read('services/baseLinkerRetention.js');
  assert(!index.includes('includeUnconfirmed: true'));
  assert(!picking.includes('includeUnconfirmed: true'));
  assert(!routes.includes('includeUnconfirmed: true'));
  assert(!retention.includes('includeUnconfirmed: true'));
  assert(orders.includes('includeUnconfirmed = false'));
  assert(orders.includes('get_unconfirmed_orders: Boolean(includeUnconfirmed)'));
  assert(index.includes('includeUnconfirmed: false'));
  assert(picking.includes('includeUnconfirmed: false'));
});
check('journal is delta accelerator and full reconcile is periodic fallback', () => {
  assert(index.includes("getJournalList"));
  assert(index.includes('JOURNAL_MAX_EXACT_PER_TICK'));
  assert(scheduler.includes('syncBaseLinkerJournalDelta'));
  assert(scheduler.includes('FULL_RECONCILE_MS'));
  assert(scheduler.includes("journal_not_ready_wait_full_reconcile"));
});
check('catalog warming has explicit bounded BaseLinker request budgets', () => {
  assert(index.includes('FULL_SCAN_PRODUCT_WARM_REQUESTS'));
  assert(index.includes('DELTA_PRODUCT_WARM_REQUESTS'));
  assert(read('services/baseLinkerProducts.js').includes('baselinker_catalog_request_budget_exhausted'));
});
check('request meter endpoint is admin-only and does not call BaseLinker', () => {
  const block = sliceBetweenOrThrow(routes, "router.get('/api-usage'", "router.post('/sync'");
  assert(block.includes("requireTelegramRole('admin')"));
  assert(block.includes('getBaseLinkerApiUsage'));
  assert(!block.includes('makeBaseLinkerAccountCaller'));
  assert(!block.includes('fetchBaseLinker'));
});
check('shift-board polling payload does not read Telegram delivery ledger', () => {
  const block = sliceBetweenOrThrow(shift, "router.get('/shift-board'", "router.get('/shift-board/seller-notifications'");
  assert(!block.includes('buildShiftTelegramDeliveryReadModel'));
  assert(!block.includes('notifications:'));
});
check('Telegram delivery audit is a lazy per-seller endpoint', () => {
  const block = sliceBetweenOrThrow(shift, "router.get('/shift-board/seller-notifications'", "router.get('/shift-board/worker-history'");
  assert(block.includes('buildShiftTelegramDeliveryReadModel'));
  assert(block.includes('recipientId: telegramId'));
});

console.log(`\n${passed}/10 BaseLinker request-efficiency checks passed`);
if (process.exitCode) process.exit(process.exitCode);
