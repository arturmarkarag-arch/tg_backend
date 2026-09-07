#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { orderKey, sourceKey, productKey, resolveSourceName } = require('../services/baseLinkerIdentity');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('A/123 and B/123 are different order identities', () => {
  assert.strictEqual(orderKey('account-A', 123), 'account-A:123');
  assert.strictEqual(orderKey('account-B', 123), 'account-B:123');
  assert.notStrictEqual(orderKey('account-A', 123), orderKey('account-B', 123));
});

check('same source number is isolated by both account and source type', () => {
  const values = [
    sourceKey('account-A', 'allegro', 150),
    sourceKey('account-A', 'amazon', 150),
    sourceKey('account-B', 'allegro', 150),
  ];
  assert.strictEqual(new Set(values).size, 3);
});

check('order_return display fallback preserves exact return identity', () => {
  assert.strictEqual(resolveSourceName({ order_return: { 0: 'Order return' } }, 'order_return', 98765), 'Order return');
  assert.notStrictEqual(
    sourceKey('account-A', 'order_return', 98765),
    sourceKey('account-B', 'order_return', 98765),
  );
});

check('same BaseLinker product ids in two accounts are different catalog identities', () => {
  const product = { storage: 'db', storage_id: 307, product_id: 2685 };
  assert.strictEqual(productKey('account-A', product), 'account-A:db:307:2685');
  assert.strictEqual(productKey('account-B', product), 'account-B:db:307:2685');
  assert.notStrictEqual(productKey('account-A', product), productKey('account-B', product));
});

check('Mongo order and picking uniqueness are account + order', () => {
  const indexModel = read('models/BaseLinkerOrderIndex.js');
  const pickingModel = read('models/BaseLinkerPickingOrder.js');
  for (const src of [indexModel, pickingModel]) {
    assert(src.includes('index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })'));
    assert(!src.includes('index({ orderId: 1 }, { unique: true })'));
  }
});

check('same package_id in two accounts cannot collide in print deduplication', () => {
  const printModel = read('models/BaseLinkerPrintJob.js');
  assert(printModel.includes('baseLinkerAccountId: { type: String, required: true'));
  assert(printModel.includes('index({ baseLinkerAccountId: 1, packageId: 1, status: 1'));
});

check('order lock namespace contains account + order', () => {
  const picking = read('services/baseLinkerPicking.js');
  assert(picking.includes('`baselinker-order:${accountId}:${requestedId}`'));
  assert(!picking.includes('`baselinker-order:${requestedId}`'));
});

check('sent/index removal is scoped to account + order', () => {
  const picking = read('services/baseLinkerPicking.js');
  const index = read('services/baseLinkerOrderIndex.js');
  assert(picking.includes('await removeIndexedOrders(accountId, [id])'));
  assert(index.includes('BaseLinkerOrderIndex.deleteMany({ baseLinkerAccountId: accountId, orderId: { $in: ids } })'));
});

check('concrete HTTP identity cannot omit accountId', () => {
  const routes = read('routes/baseLinker.js');
  assert(routes.includes("router.get('/accounts/:accountId/orders/:orderId', asyncHandler(exactOrderHandler))"));
  assert(routes.includes("const pickingPrefix = '/accounts/:accountId/picking/orders/:orderId'"));
  assert(routes.includes("/accounts/:accountId/orders/:orderId/packages/:packageId/print"));
  assert(routes.includes("if (req.query.orderId !== undefined) throw appError('baselinker_exact_order_requires_account_path')"));
});

check('API caller token lookup is account-bound', () => {
  const client = read('services/baseLinkerClient.js');
  assert(client.includes('getTokenForAccount(id'));
  assert(client.includes('reserveApiBudget(id, { method: upstreamMethod, usageStage })'));
  assert(client.includes("'X-BLToken': secret"));
});

console.log(`\n${passed} backend BaseLinker collision checks passed`);
if (process.exitCode) process.exit(process.exitCode);
