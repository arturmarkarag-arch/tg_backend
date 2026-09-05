#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

const scopeSrc = read('services/baseLinkerQueueScope.js');
const cacheSrc = read('services/baseLinkerOrderCache.js');
const ordersSrc = read('services/baseLinkerOrders.js');
const journalSrc = read('services/baseLinkerJournal.js');
const pickingSrc = read('services/baseLinkerPicking.js');
const routeSrc = read('routes/baseLinker.js');
const errorsSrc = read('utils/errors.js');
const modelSrc = read('models/BaseLinkerPickingOrder.js');
const commandSrc = read('services/baseLinkerOrderCommands.js');
const shipmentsSrc = read('services/baseLinkerShipments.js');
const snapshotSrc = read('services/baseLinkerOrderSnapshots.js');
const accountSrc = read('services/baseLinkerAccount.js');
const printSrc = read('services/baseLinkerPrint.js');

check('three distinct queue status ids are required', () => {
  assert(scopeSrc.includes('intakeStatusId'));
  assert(scopeSrc.includes('sentStatusId'));
  assert(scopeSrc.includes('cancelledStatusId'));
  assert(scopeSrc.includes('new Set([intakeStatusId, sentStatusId, cancelledStatusId]'));
});
check('Intake has no date boundary', () => {
  const block = cacheSrc.slice(cacheSrc.indexOf('const intake = await fetchBaseLinkerOrders'), cacheSrc.indexOf('const sent = await fetchBaseLinkerOrders'));
  assert(block.includes('statusId: scope.intakeStatusId'));
  assert(!block.includes('dateConfirmedFrom'));
});
check('Sent is fixed to 30 days', () => {
  assert(scopeSrc.includes('const SENT_LOOKBACK_DAYS = 30'));
  assert(cacheSrc.includes('dateConfirmedFrom: scope.sentDateConfirmedFrom'));
});
check('Cancelled is not mass-scanned', () => {
  const scan = cacheSrc.slice(cacheSrc.indexOf('async function scanConfiguredScopes'), cacheSrc.indexOf('async function bootstrapCacheUnlocked'));
  assert(!scan.includes('statusId: scope.cancelledStatusId'));
});
check('status-only intake scan uses id_from pagination', () => {
  assert(ordersSrc.includes('const idCursorMode = unconfirmedMode || baseParams.date_confirmed_from === undefined'));
  assert(ordersSrc.includes('params.id_from = cursor'));
});
check('journal refreshes exact changed orders', () => {
  assert(journalSrc.includes('fetchBaseLinkerOrders({ orderId, includeUnconfirmed: true, maxPages: 1 })'));
  assert(journalSrc.includes('refreshBaseLinkerOrderCache({ orders: exactOrders, removedOrderIds })'));
});
check('journal remembers prior cache membership before cancellation refresh', () => {
  assert(journalSrc.includes('getKnownCachedOrderIds(window.orderIds)'));
  assert(journalSrc.includes('knownCachedOrderIds'));
});
check('known cancelled order can be materialised into Updated before claim', () => {
  assert(pickingSrc.includes("classifyUpstreamOrder(order, scope) !== 'cancelled'"));
  assert(pickingSrc.includes("upstreamDisposition: 'cancelled'"));
  assert(pickingSrc.includes("appendHistory(doc, 'upstream_cancelled_before_claim'"));
});
check('cancelled/sent upstream states block warehouse mutations', () => {
  assert(pickingSrc.includes("if (disposition === 'cancelled') throw appError('baselinker_order_cancelled')"));
  assert(pickingSrc.includes("if (disposition === 'sent') throw appError('baselinker_order_already_sent')"));
});
check('upstream acknowledgement clears only review attention', () => {
  assert(pickingSrc.includes('doc.upstreamReviewRequired = false'));
  assert(pickingSrc.includes("appendHistory(doc, 'upstream_change_reviewed'"));
});
check('any meaningful BaseLinker order event can mark Updated', () => {
  const expected = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,16,17,18,19,20,21,22];
  for (const type of expected) assert(new RegExp(`\\b${type},?\\s*//`).test(journalSrc), `missing journal type ${type}`);
  assert(!/\b15,\s*\/\//.test(journalSrc));
});
check('packing with unresolved problems has no bypass', () => {
  assert(!routeSrc.includes('allowIssues'));
  assert(!pickingSrc.includes('allowIssues'));
  assert(pickingSrc.includes("appError('baselinker_picking_has_unresolved_issues'"));
});
check('Sent is the sole explicit upstream write and is exact-order verified', () => {
  assert(commandSrc.includes("callApi('setOrderStatus'"));
  assert(commandSrc.includes('order_id: order'));
  assert(commandSrc.includes('status_id: status'));
  assert(pickingSrc.includes('setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId })'));
  assert(pickingSrc.includes('fetchExactOrder(id)'));
  assert(pickingSrc.includes("appError('baselinker_order_status_write_unverified'"));
  for (const token of ['setOrderStatuses', 'addOrder', 'deleteOrder', 'setOrderFields']) {
    assert(!pickingSrc.includes(token) && !cacheSrc.includes(token) && !journalSrc.includes(token) && !commandSrc.includes(token), token);
  }
});
check('exact accountScope + orderId is the only picking identity', () => {
  assert(modelSrc.includes("index({ accountScope: 1, orderId: 1 }, { unique: true })"));
  for (const token of ['memberOrderIds', 'claimKey', 'groupKey']) assert(!modelSrc.includes(token), token);
  for (const token of ['mergeOrderGroup', 'fetchExactOrderGroup', 'claimKeyForGroup']) assert(!pickingSrc.includes(token), token);
});
check('API token structure is never treated as stable account identity', () => {
  assert(accountSrc.includes("source: 'token_fingerprint'"));
  assert(accountSrc.includes('API tokens are credentials, not account identity'));
  assert(!accountSrc.includes("split('-')"));
});
check('immutable content-addressed order snapshots are persisted', () => {
  assert(snapshotSrc.includes("createHash('sha256')"));
  assert(snapshotSrc.includes('snapshotHash'));
  assert(snapshotSrc.includes('BaseLinkerOrderSnapshot.bulkWrite'));
  assert(snapshotSrc.includes('$setOnInsert'));
  assert(snapshotSrc.includes('upsert: true'));
});
check('TTN/label/print require exact order-to-package verification', () => {
  assert(shipmentsSrc.includes('fetchVerifiedBaseLinkerOrderPackage'));
  assert(shipmentsSrc.includes('fetchBaseLinkerOrderPackages(orderId'));
  assert(shipmentsSrc.includes("appError('baselinker_package_order_mismatch'"));
  assert(printSrc.includes('fetchVerifiedBaseLinkerOrderPackage'));
  assert(printSrc.includes('orderId'));
});

check('operator-facing errors exist for upstream terminal states', () => {
  assert(errorsSrc.includes('baselinker_order_cancelled'));
  assert(errorsSrc.includes('baselinker_order_already_sent'));
});
check('/status exposes all three upstream statuses and Sent retention', () => {
  for (const token of ['intakeStatusId', 'sentStatusId', 'cancelledStatusId', 'sentLookbackDays']) assert(routeSrc.includes(token));
});
check('Packed shelf can be filtered by actual packing actor before pagination', () => {
  assert(routeSrc.includes('packedBy: req.query.packedBy'));
  assert(cacheSrc.includes("safeWorkflow === 'packed' && safePackedBy"));
  assert(cacheSrc.includes("localPackedBy: safePackedBy"));
  assert(cacheSrc.includes("facet?.pageTotal?.[0]?.count"));
});
check('Packed actor options come from persisted packedBy facts', () => {
  assert(cacheSrc.includes("packedBy: { $nin: ['', null] }"));
  assert(cacheSrc.includes("name: { $first: '$packedByName' }"));
  assert(cacheSrc.includes('packedByOptions'));
});
check('Packed actor query has a supporting index', () => {
  assert(modelSrc.includes('workflowStage: 1, packedBy: 1, packedAt: -1'));
});

// Small dependency-free behavior proof for queue scope semantics.
function loadScope() {
  const filename = path.join(root, 'services/baseLinkerQueueScope.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const mocks = {
    '../models/AppSetting': { findOne: () => ({ lean: async () => null }), findOneAndUpdate: async () => ({}) },
    './baseLinkerClient': { callBaseLinker: async () => ({ statuses: [] }) },
    '../utils/errors': { appError: (code) => Object.assign(new Error(code), { code, status: 400 }) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, Date, require: (id) => mocks[id] || realRequire(id) });
  return module.exports;
}
const scope = loadScope();
const now = Date.now();
const cfg = scope.queueScopeFromSettings({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'gate' }, now);
check('behavior: ancient Intake order is still in scope', () => assert.equal(scope.orderInIntakeScope({ order_status_id: 99, confirmed: true, date_confirmed: 1 }, cfg), true));
check('behavior: Sent older than 30 days is out of scope', () => assert.equal(scope.orderInSentScope({ order_status_id: 100, confirmed: true, date_confirmed: cfg.sentDateConfirmedFrom - 1 }, cfg), false));
check('behavior: current Cancelled status classifies terminal', () => assert.equal(scope.classifyUpstreamOrder({ order_status_id: 101 }, cfg), 'cancelled'));



check('item problem cannot auto-defer an order; only explicit release owns Deferred', () => {
  const pickingState = read('domain/baseLinkerPickingState.js');
  const picking = read('services/baseLinkerPicking.js');
  assert(pickingState.includes('Item-level state must never move the whole order between operational'));
  assert(!pickingState.includes("if ([ORDER_STATUS.PROBLEM, ORDER_STATUS.READY_WITH_ISSUE].includes"));
  assert(picking.includes('doc.workflowStage = WORKFLOW_STAGE.DEFERRED'));
  assert(picking.includes("appendHistory(doc, 'order_released'"));
  assert(picking.includes('shouldRepairImplicitAutoDeferred'));
  assert(picking.includes("action: 'implicit_problem_autodefer_repaired'"));
  assert(picking.includes("action === 'order_released'"));
  assert(picking.includes("action === 'order_reopened_by_admin'"));
});


check('client mutation ids are echoed through HTTP and realtime picking events', () => {
  assert(routeSrc.includes('function clientMutationIdFromRequest'));
  assert(routeSrc.includes('clientMutationId,'));
  assert(routeSrc.includes("{ clientMutationId }"));
  assert(pickingSrc.includes('function emitPickingUpdate(doc, clientMutationId'));
  assert(pickingSrc.includes("clientMutationId: text(clientMutationId).trim().slice(0, 160)"));
  for (const signature of [
    'claimPickingOrder({ orderId, user, force = false, clientMutationId =',
    'updatePickingItem({ orderId, lineKey, user, expectedRevision, state, pickedQty, issueNote, clientMutationId =',
    'releasePickingOrder({ orderId, user, expectedRevision, force = false, clientMutationId =',
    'markPickingOrderPacked({ orderId, user, expectedRevision, clientMutationId =',
    'markPickingOrderSent({ orderId, user, expectedRevision, clientMutationId =',
  ]) assert(pickingSrc.includes(signature), signature);
});

if (!process.exitCode) console.log(`\nBaseLinker source-of-truth server gate: ${passed}/${passed} PASS`);
