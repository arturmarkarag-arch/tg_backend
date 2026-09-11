#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
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

const files = {
  accountModel: read('models/BaseLinkerAccount.js'),
  accountService: read('services/baseLinkerAccounts.js'),
  validation: read('services/baseLinkerAccountValidation.js'),
  client: read('services/baseLinkerClient.js'),
  identity: read('services/baseLinkerIdentity.js'),
  scope: read('services/baseLinkerQueueScope.js'),
  indexModel: read('models/BaseLinkerOrderIndex.js'),
  pickingModel: read('models/BaseLinkerPickingOrder.js'),
  printModel: read('models/BaseLinkerPrintJob.js'),
  index: read('services/baseLinkerOrderIndex.js'),
  picking: read('services/baseLinkerPicking.js'),
  products: read('services/baseLinkerProducts.js'),
  shipments: read('services/baseLinkerShipments.js'),
  print: read('services/baseLinkerPrint.js'),
  scheduler: read('services/baseLinkerQueueScheduler.js'),
  retention: read('services/baseLinkerRetention.js'),
  routes: read('routes/baseLinker.js'),
  admin: read('routes/admin.js'),
  domain: read('domain/baseLinkerPickingState.js'),
  orders: read('services/baseLinkerOrders.js'),
  doc: read('docs/architecture/baselinker-orders.md'),
};
const runtime = Object.entries(files).filter(([key]) => key !== 'doc').map(([, value]) => value).join('\n');

check('BaseLinker runtime has no global API-token fallback', () => {
  assert(!runtime.includes('BASELINKER_API_TOKEN'));
  assert(!runtime.includes('process.env.BASELINKER_API_TOKEN'));
  assert(!exists('services/baseLinkerPickingSettings.js'));
});

check('every connection has our required durable UUID', () => {
  assert(files.accountModel.includes("accountId: { type: String, required: true"));
  assert(files.accountModel.includes('index({ accountId: 1 }, { unique: true })'));
  assert(files.accountService.includes('const accountId = crypto.randomUUID()'));
});

check('token encryption is server-only AES-GCM bound to account UUID', () => {
  assert(files.accountService.includes("const MASTER_KEY_ENV = 'BASELINKER_TOKEN_ENCRYPTION_KEY'"));
  assert(files.accountService.includes("crypto.createCipheriv('aes-256-gcm'"));
  assert(files.accountService.includes("cipher.setAAD(Buffer.from(id, 'utf8'))"));
  assert(files.accountService.includes("decipher.setAAD(Buffer.from(id, 'utf8'))"));
  assert(files.accountModel.includes('tokenEncrypted: { type: EncryptedTokenSchema, required: true }'));
  assert(files.accountModel.includes('tokenFingerprint: { type: String, required: true, select: false }'));
  assert(!files.accountService.includes('token: plain.token'));
});

check('account create is complete and queue is mandatory', () => {
  assert(files.accountModel.includes('queue: { type: QueueSettingsSchema, required: true }'));
  for (const token of ['intakeStatusId', 'sentStatusId', 'cancelledStatusId']) {
    assert(files.accountModel.includes(`${token}: { type: Number, required: true`), token);
  }
  assert(files.accountService.includes('const validatedQueue = buildValidatedQueue(queue, statuses)'));
  assert(files.accountService.includes('queue: validatedQueue'));
});

check('token validation uses official read-only metadata methods', () => {
  for (const method of ['getOrderStatusList', 'getOrderSources', 'getInventories']) {
    assert(files.validation.includes(`callApi('${method}'`), method);
  }
});

check('ordinary metadata refresh is enabled-only; disabled probing is explicit admin maintenance', () => {
  assert(files.validation.includes("async function refreshBaseLinkerAccountMetadata(accountId, { allowDisabled = false } = {})"));
  assert(files.validation.includes('const requireEnabled = allowDisabled !== true'));
  assert(files.validation.includes('getBaseLinkerAccount(id, { requireEnabled: true, lean: true })'));
  assert(files.admin.includes('refreshBaseLinkerAccountMetadata(req.params.accountId, { allowDisabled: true })'));
});

check('API caller is account-bound and budgeted per account', () => {
  assert(files.client.includes("'X-BLToken': secret"));
  assert(files.client.includes('reserveApiBudget(id, { method: upstreamMethod, usageStage })'));
  assert(files.client.includes('BASELINKER_REQUEST_BUDGET_PER_MINUTE'));
  assert(files.client.includes('getTokenForAccount(id'));
  assert(files.client.includes('makeBaseLinkerAccountCaller'));
});

check('canonical order and source identities include our account UUID', () => {
  const { orderKey, sourceKey } = require('../services/baseLinkerIdentity');
  assert.strictEqual(orderKey('A', '123'), 'A:123');
  assert.strictEqual(orderKey('B', '123'), 'B:123');
  assert.notStrictEqual(orderKey('A', '123'), orderKey('B', '123'));
  assert.strictEqual(sourceKey('A', 'allegro', '150'), 'A:allegro:150');
  assert.notStrictEqual(sourceKey('A', 'allegro', '150'), sourceKey('A', 'amazon', '150'));
  assert.notStrictEqual(sourceKey('A', 'allegro', '150'), sourceKey('B', 'allegro', '150'));
});

check('Mongo order identity is composite account + order', () => {
  assert(files.indexModel.includes('index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })'));
  assert(files.pickingModel.includes('index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })'));
  assert(!files.indexModel.includes('index({ orderId: 1 }, { unique: true })'));
  assert(!files.pickingModel.includes('index({ orderId: 1 }, { unique: true })'));
});

check('minimal queue index has server-filterable source identity but no full order/customer payload', () => {
  for (const token of ['baseLinkerAccountId:', 'orderId:', 'orderSortDate:', 'sourceType:', 'sourceId:']) assert(files.indexModel.includes(token), token);
  for (const forbidden of ['products:', 'deliveryAddress:', 'delivery_address:', 'customer:', 'phone:', 'email:', 'rawOrder:']) {
    assert(!files.indexModel.includes(forbidden), forbidden);
  }
  assert(files.index.includes('selectedSourceAccountId'));
  assert(files.index.includes('selectedSourceType'));
  assert(files.index.includes('selectedSourceId'));
});

check('global multi-account ordering uses timestamps rather than comparing order IDs across accounts', () => {
  assert(files.index.includes('orderSortDate: Number(order?.date_confirmed || order?.date_add'));
  assert(files.index.includes('const ad = Number(a.orderSortDate || 0)'));
});

check('picking locks and all concrete picking queries are account-scoped', () => {
  assert(files.picking.includes('`baselinker-order:${accountId}:${id}`'));
  assert(files.picking.includes('{ baseLinkerAccountId: accountId, orderId: id }'));
  assert(files.picking.includes('makeBaseLinkerAccountCaller(accountId,'));
});

check('one-worker active-order rule remains global across marketplace providers', () => {
  assert(files.picking.includes('`marketplace-worker:${actor.by}`'));
  assert(files.picking.includes('AllegroPickingOrder.findOne'));
  assert(files.pickingModel.includes('index({ ownerTelegramId: 1, status: 1 })'));
});

check('product catalogue and print/package paths carry account identity', () => {
  assert(files.products.includes('baseLinkerAccountId'));
  assert(files.printModel.includes('baseLinkerAccountId: { type: String, required: true'));
  assert(files.printModel.includes('index({ baseLinkerAccountId: 1, packageId: 1, status: 1'));
  assert(files.shipments.includes('fetchVerifiedBaseLinkerOrderPackage'));
  assert(files.shipments.includes("if (typeof callApi !== 'function') throw appError('baselinker_account_id_required')"));
  assert(files.print.includes('baseLinkerAccountId'));
});

check('concrete BaseLinker HTTP routes are account-scoped', () => {
  assert(files.routes.includes("/accounts/:accountId/orders/:orderId/packages"));
  assert(files.routes.includes("const pickingPrefix = '/accounts/:accountId/picking/orders/:orderId'"));
  for (const suffix of ['/claim', '/items/:lineKey', '/packed', '/sent']) assert(files.routes.includes('`${pickingPrefix}' + suffix + '`') || files.routes.includes(`\`${'${pickingPrefix}'}${suffix}\``), suffix);
  assert(!/router\.(get|post|patch|delete)\('\/(orders|picking\/orders)\/:orderId/.test(files.routes));
});

check('admin surface is account CRUD/maintenance, not a global queue setting', () => {
  for (const route of [
    "/baselinker-settings/accounts",
    "/baselinker-settings/accounts/:accountId/token",
    "/baselinker-settings/accounts/:accountId/refresh",
    "/baselinker-settings/accounts/:accountId/queue",
  ]) assert(files.admin.includes(route), route);
  assert(!files.admin.includes("AppSetting.findOne({ key: 'baselinker.queueSettings"));
});

check('disabled accounts are excluded from normal queue synchronization', () => {
  assert(files.index.includes('getAllQueueScopes({ enabledOnly: true })'));
  assert(files.scheduler.includes('getAllQueueScopes({ enabledOnly: true })'));
  assert(files.retention.includes('listBaseLinkerAccounts({ includeDisabled: false })'));
});

check('current picking schema has no BaseLinker legacy line/workflow/packing fallbacks', () => {
  assert(!files.domain.includes("'damaged'"));
  assert(!files.domain.includes("'other'"));
  assert(!files.domain.includes('LEGACY_ISSUE_STATES'));
  assert(!files.domain.includes('legacyWorkflowStageForStatus'));
  assert(files.pickingModel.includes("enum: ['', 'full']"));
  assert(!files.pickingModel.includes("'partial'"));
  assert(!files.pickingModel.includes("'with_issue'"));
});

check('one account-scoped Intake poll is the only periodic queue discovery path', () => {
  assert(files.index.includes('statusId: scope.intakeStatusId'));
  assert(files.scheduler.includes('baselinker-queue-poll:'));
  assert(files.scheduler.includes('queue_poll_fresh'));
  assert(!files.index.includes('getJournalList'));
  assert(!files.index.includes('primeJournalCursor'));
  assert(!files.scheduler.includes('syncBaseLinkerJournalDelta'));
});

check('Sent mutation is bound to the same account and removes only that account/order index row', () => {
  assert(files.picking.includes("setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId }, makeBaseLinkerAccountCaller(accountId, { usageStage: 'picking_status_write' }))"));
  assert(files.picking.includes('await removeIndexedOrders(accountId, [id])'));
});

check('greenfield BaseLinker runtime has no account inference/backfill/drop migration machinery', () => {
  for (const forbidden of ['inferSingle', 'backfill', 'baselinkerordercaches', 'baselinkerordersnapshots', 'accountScope']) {
    assert(!runtime.includes(forbidden), forbidden);
  }
});


check('queue reads are intake-only status scans with id_from and no date/period mode', () => {
  assert(files.orders.includes('status_id'));
  assert(files.orders.includes('id_from'));
  assert(!files.orders.includes('date_confirmed_from'));
  assert(!files.orders.includes('date_from'));
  assert(!files.orders.includes('date_to'));
  assert(files.index.includes('statusId: scope.intakeStatusId'));
  assert(!files.index.includes('statusId: scope.sentStatusId'));
  assert(!files.index.includes('statusId: scope.cancelledStatusId'));
});

check('departure reconciliation uses the complete Intake scan and spends zero extra API requests', () => {
  const start = files.index.indexOf('async function reconcileIndexTransition');
  const end = files.index.indexOf('async function performIndexSync', start);
  const transition = files.index.slice(start, end);
  assert(transition.includes('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))'));
  assert(transition.includes('removedOrderIds: trackedDepartedIds'));
  assert(!transition.includes('await exactOrder('));
  assert(files.index.includes('orderId: { $in: transition.removedOrderIds }'));
});

check('API budget determines safe queue scan depth instead of allowing an unbounded status mirror', () => {
  assert(files.index.includes('SAFE_INDEX_PAGES_PER_SCAN'));
  assert(files.index.includes('BASELINKER_REQUEST_BUDGET_PER_MINUTE - SYNC_REQUEST_RESERVE_PER_MINUTE'));
  assert(files.index.includes('INDEX_MAX_PAGES = Math.min(60, SAFE_INDEX_PAGES_PER_SCAN, REQUESTED_INDEX_MAX_PAGES)'));
  assert(files.index.includes("throw appError('baselinker_order_index_truncated'"));
});

check('worker pagination is intentionally only 10 or 20 orders', () => {
  assert(files.index.includes('const PAGE_SIZE_VALUES = new Set([10, 20])'));
  assert(files.index.includes('return PAGE_SIZE_VALUES.has(n) ? n : 10'));
});

check('queue configuration persists only status IDs; names are metadata-derived snapshots', () => {
  const queueBlock = files.accountModel.slice(files.accountModel.indexOf('const QueueSettingsSchema'), files.accountModel.indexOf('const EncryptedTokenSchema'));
  assert(queueBlock.includes('intakeStatusId'));
  assert(queueBlock.includes('sentStatusId'));
  assert(queueBlock.includes('cancelledStatusId'));
  assert(!queueBlock.includes('StatusName'));
  assert(files.scope.includes('metadataSnapshot?.statuses'));
  assert(files.scope.includes('intakeStatusName: String(resolved[0]?.name || \'\')'));
});

check('disabled -> enabled transition is live-validated and cannot bypass the service guard', () => {
  assert(files.accountService.includes('async function updateBaseLinkerAccount(accountId, patch = {}, { allowEnable = false } = {})'));
  assert(files.accountService.includes("throw appError('baselinker_account_enable_validation_required')"));
  assert(files.admin.includes('if (req.body?.enabled === true && current.enabled !== true)'));
  assert(files.admin.includes('refreshBaseLinkerAccountMetadata(req.params.accountId, { allowDisabled: true })'));
  assert(files.admin.includes('buildValidatedQueue(current.queue || {}, validation.metadata.statuses)'));
});

check('exact order read is canonical account-scoped path, not an orderId query shortcut', () => {
  assert(files.routes.includes("router.get('/accounts/:accountId/orders/:orderId', asyncHandler(exactOrderHandler))"));
  assert(files.routes.includes("if (req.query.orderId !== undefined) throw appError('baselinker_exact_order_requires_account_path')"));
});

check('documented order_return display fallback never weakens exact source identity', () => {
  const { sourceKey, resolveSourceName } = require('../services/baseLinkerIdentity');
  const sources = { order_return: { 0: 'Order return' } };
  assert.strictEqual(resolveSourceName(sources, 'order_return', 98765), 'Order return');
  assert.strictEqual(sourceKey('A', 'order_return', 98765), 'A:order_return:98765');
  assert.notStrictEqual(sourceKey('A', 'order_return', 98765), sourceKey('B', 'order_return', 98765));
});

check('greenfield archive contains no BaseLinker migration/P0 compatibility artifacts', () => {
  for (const rel of [
    'BASELINKER_ID_INDEX_MIGRATION_20260906.txt',
    'PATCH_README_P0_20260906.txt',
    'scripts/checkBaseLinkerSourceOfTruth20260905.js',
  ]) assert(!exists(rel), rel);
});

check('canonical architecture document describes intake-only reconciliation and no legacy support', () => {
  assert(files.doc.includes('Greenfield'));
  assert(files.doc.includes('Intake'));
  assert(files.doc.includes('id_from'));
  assert(files.doc.includes('exact'));
  assert(files.doc.includes('no legacy'));
});

console.log(`\n${passed} BaseLinker multi-account contract checks passed`);
if (process.exitCode) process.exit(process.exitCode);
