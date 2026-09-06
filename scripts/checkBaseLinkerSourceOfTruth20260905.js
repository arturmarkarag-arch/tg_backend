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
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

const scopeSrc = read('services/baseLinkerQueueScope.js');
const indexSrc = read('services/baseLinkerOrderIndex.js');
const indexModelSrc = read('models/BaseLinkerOrderIndex.js');
const ordersSrc = read('services/baseLinkerOrders.js');
const schedulerSrc = read('services/baseLinkerQueueScheduler.js');
const pickingSrc = read('services/baseLinkerPicking.js');
const pickingModelSrc = read('models/BaseLinkerPickingOrder.js');
const routeSrc = read('routes/baseLinker.js');
const indexEntrySrc = read('index.js');
const commandSrc = read('services/baseLinkerOrderCommands.js');
const shipmentsSrc = read('services/baseLinkerShipments.js');
const printSrc = read('services/baseLinkerPrint.js');
const retentionSrc = read('services/baseLinkerRetention.js');
const errorsSrc = read('utils/errors.js');

check('queue still requires explicit Intake, Sent and Cancelled status ids', () => {
  for (const token of ['intakeStatusId', 'sentStatusId', 'cancelledStatusId']) assert(scopeSrc.includes(token), token);
  assert(scopeSrc.includes('new Set([intakeStatusId, sentStatusId, cancelledStatusId]'));
});

check('minimal order index persists identity only, never a BaseLinker order payload', () => {
  for (const token of ['orderId:', 'orderIdNumeric:', 'syncToken:', 'seenAt:']) assert(indexModelSrc.includes(token), token);
  assert(!/\border\s*:/.test(indexModelSrc));
  for (const forbidden of ['products:', 'deliveryAddress:', 'delivery_address:', 'customer:', 'email:', 'phone:', 'rawOrder:']) assert(!indexModelSrc.includes(forbidden), forbidden);
});

check('retired full-order mirror and snapshot model/service files are physically absent', () => {
  for (const rel of [
    'models/BaseLinkerOrderCache.js',
    'models/BaseLinkerOrderSnapshot.js',
    'services/baseLinkerOrderCache.js',
    'services/baseLinkerOrderSnapshots.js',
  ]) assert(!exists(rel), rel);
});

check('journal is not a runtime dependency', () => {
  assert(!exists('services/baseLinkerJournal.js'));
  for (const src of [indexSrc, schedulerSrc, pickingSrc, routeSrc, indexEntrySrc]) {
    assert(!src.includes('baseLinkerJournal'));
    assert(!src.includes('getJournalList'));
    assert(!src.includes('journalScheduler'));
    assert(!src.includes('fallbackPending'));
  }
});

check('server scheduler refreshes only the minimal queue index', () => {
  assert(indexEntrySrc.includes('startBaseLinkerQueueScheduler'));
  assert(schedulerSrc.includes('syncBaseLinkerOrderIndex({ force: true })'));
  assert(schedulerSrc.includes("runAsSchedulerLeader('baselinker-queue-index'"));
});

check('background scan uses Intake status as the admission gate and includes unconfirmed rows', () => {
  const scan = indexSrc.slice(indexSrc.indexOf('async function scanIntake'), indexSrc.indexOf('async function exactOrder'));
  assert(scan.includes('statusId: scope.intakeStatusId'));
  assert(scan.includes('includeUnconfirmed: true'));
  assert(!scan.includes('scope.sentStatusId'));
  assert(!scan.includes('scope.cancelledStatusId'));
});

check('BaseLinker status scan uses documented id_from cursor', () => {
  assert(ordersSrc.includes('idFrom'));
  assert(ordersSrc.includes('params.id_from = fromId'));
  assert(ordersSrc.includes('params.id_from = cursor'));
  assert(ordersSrc.includes('const advanced = lastOrderId + 1'));
});

check('warehouse reads include unconfirmed because Intake status is the business-ready gate', () => {
  assert(indexSrc.includes('includeUnconfirmed: true'));
  assert(pickingSrc.includes('includeUnconfirmed: true'));
  assert(retentionSrc.includes('includeUnconfirmed: true'));
  assert(routeSrc.includes('includeUnconfirmed: true'));
  assert(!indexSrc.includes('order?.confirmed !== false'));
});

check('new Intake index stores only order ids extracted from transient API responses', () => {
  assert(indexSrc.includes('orderId: String(order.order_id)'));
  assert(indexSrc.includes('orderIdNumeric: Number(order.order_id)'));
  assert(!indexSrc.includes('order: compactOrder(order)'));
  assert(!indexSrc.includes('rawOrder'));
});

check('selected untouched Intake rows are read live in a batched status/id_from request', () => {
  assert(indexSrc.includes('async function liveIntakeOrdersForIds'));
  assert(indexSrc.includes('statusId: scope.intakeStatusId'));
  assert(indexSrc.includes('idFrom: Math.min(...numeric)'));
  assert(indexSrc.includes('maxPages: 2'));
});

check('tracked workflow rows render from PickingOrder instead of a BaseLinker mirror', () => {
  assert(indexSrc.includes('function orderFromPicking'));
  assert(indexSrc.includes('BaseLinkerPickingOrder.find({}).lean()'));
  assert(indexSrc.includes('const order = orderFromPicking(doc)'));
});

check('PickingOrder persists our business work and minimal source line identity', () => {
  for (const token of ['items:', 'requestedQty:', 'pickedQty:', 'issueNote:', 'ownerTelegramId:', 'workflowStage:', 'revision:']) assert(pickingModelSrc.includes(token), token);
  for (const token of ['storage:', 'storageId:', 'productId:', 'variantId:', 'sku:', 'ean:', 'attributes:']) assert(pickingModelSrc.includes(token), token);
  assert(!pickingModelSrc.includes('lastUpstreamJournalTypes'));
});

check('full-order legacy collections are auto-dropped on migration', () => {
  assert(indexSrc.includes("'baselinkerordercaches'"));
  assert(indexSrc.includes("'baselinkerordersnapshots'"));
  assert(indexSrc.includes("'baselinker.orderCache.v2'"));
  assert(indexSrc.includes("'baselinker.journal.v1'"));
});

check('departed Intake ids are exact-read before removal', () => {
  assert(indexSrc.includes('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))'));
  assert(indexSrc.includes('const order = await exactOrder(id)'));
  assert(indexSrc.includes('reconcilePickingFromUpstreamChanges'));
});

check('unclaimed departed ids can materialize local review/cancelled history', () => {
  assert(indexSrc.includes('knownAdmittedOrderIds'));
  assert(pickingSrc.includes('async function markPickingOrdersUpstreamUpdated'));
  assert(pickingSrc.includes("upstream_cancelled_before_claim"));
  assert(pickingSrc.includes("upstream_updated_before_claim"));
});

check('local workflow survives ordinary non-Intake BaseLinker statuses', () => {
  assert(pickingSrc.includes('Intake is only the admission status for new queue rows'));
  assert(pickingSrc.includes("if (disposition === 'cancelled') throw appError('baselinker_order_cancelled'"));
  assert(pickingSrc.includes("if (disposition === 'sent') throw appError('baselinker_order_already_sent'"));
  assert(!pickingSrc.includes("appError('baselinker_order_not_actionable'"));
  assert(!errorsSrc.includes('baselinker_order_not_actionable'));
});

check('missing exact order is explicit and cannot be silently mutated', () => {
  assert(pickingSrc.includes("if (disposition === 'missing') throw appError('baselinker_order_not_returned'"));
  assert(pickingSrc.includes("doc.upstreamDisposition = 'missing'"));
});

check('one lock namespace protects exact order mutations and background reconciliation', () => {
  const pickingLocks = [...pickingSrc.matchAll(/withLock\(`(baselinker-[^`$]+)\$\{[^}]+\}`/g)].map((m) => m[1]);
  assert(pickingLocks.includes('baselinker-order:'));
  assert(!pickingSrc.includes('baselinker-picking:'));
});

check('Mongo optimistic concurrency is a durable backstop', () => {
  assert(pickingModelSrc.includes('optimisticConcurrency: true'));
  assert(pickingSrc.includes("if (error?.name === 'VersionError')"));
  assert(pickingSrc.includes("appError('baselinker_picking_stale'"));
});

check('stable 30s queue scans do not invalidate the client when membership is unchanged', () => {
  assert(indexSrc.includes('const membershipChanged ='));
  assert(indexSrc.includes('if (membershipChanged)'));
  assert(indexSrc.includes("reason: 'queue_index_membership_changed'"));
});

check('failed scope migration preserves last successful scope for retry', () => {
  assert(indexSrc.includes('scopeKey: state.scopeKey'));
  assert(indexSrc.includes('reset/rebuild the index'));
});

check('Sent is the sole explicit upstream order-status mutation', () => {
  assert(commandSrc.includes("callApi('setOrderStatus'"));
  assert(pickingSrc.includes('setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId })'));
  assert(pickingSrc.includes("appError('baselinker_order_status_write_unverified'"));
  for (const forbidden of ['setOrderFields', 'deleteOrder', 'addOrder']) assert(!pickingSrc.includes(forbidden), forbidden);
});

check('successful Sent removes order immediately from Intake id index', () => {
  assert(pickingSrc.includes("require('./baseLinkerOrderIndex')"));
  assert(pickingSrc.includes('await removeIndexedOrders([id])'));
});

check('CRM has no cancellation write path to BaseLinker', () => {
  assert(!commandSrc.includes('cancel'));
  assert(!pickingSrc.includes('setBaseLinkerOrderStatus({ orderId: id, statusId: scope.cancelledStatusId'));
});

check('exact order id remains the sole warehouse identity', () => {
  assert(pickingModelSrc.includes('index({ orderId: 1 }, { unique: true })'));
  for (const token of ['memberOrderIds', 'groupKey', 'claimKey', 'accountScope']) assert(!pickingModelSrc.includes(token), token);
});

check('single-account runtime has no account namespace machinery', () => {
  for (const src of [indexSrc, pickingSrc, routeSrc, scopeSrc, ordersSrc, printSrc]) assert(!src.includes('accountScope'));
  assert(!exists('services/baseLinkerAccount.js'));
  assert(!exists('models/plugins/baseLinkerAccountScope.js'));
});

check('TTN and print still verify exact order-package ownership', () => {
  assert(shipmentsSrc.includes('fetchVerifiedBaseLinkerOrderPackage'));
  assert(shipmentsSrc.includes('fetchBaseLinkerOrderPackages(orderId'));
  assert(shipmentsSrc.includes("appError('baselinker_package_order_mismatch'"));
  assert(printSrc.includes('fetchVerifiedBaseLinkerOrderPackage'));
});

check('terminal local history retention remains 14 days and fail-closed', () => {
  assert(scopeSrc.includes('const HISTORY_LOOKBACK_DAYS = 14'));
  assert(retentionSrc.includes('BASELINKER_HISTORY_RETENTION_DAYS = HISTORY_LOOKBACK_DAYS'));
  assert(retentionSrc.includes('BaseLinkerPickingOrder.deleteOne'));
  assert(retentionSrc.includes("if (classifyUpstreamOrder(order, scope) === 'intake') return"));
  assert(retentionSrc.includes('includeUnconfirmed: true'));
});

check('manual refresh is a real upstream Intake index refresh', () => {
  assert(routeSrc.includes("router.post('/sync'"));
  assert(routeSrc.includes('syncBaseLinkerOrderIndex({ force: true })'));
});

check('/status reports queue index health, not journal/fallback health', () => {
  for (const token of ['queueIndexInitialized', 'queueIndexOrderCount', 'lastQueueSyncAt', 'lastQueueSyncError', 'queueSchedulerStarted', 'queueRefreshMs']) assert(routeSrc.includes(token), token);
  for (const forbidden of ['journalSchedulerStarted', 'journalPossiblyDisabled', 'fallbackPendingOrderCount']) assert(!routeSrc.includes(forbidden), forbidden);
});

check('all six local shelves remain first-class', () => {
  for (const stage of ['processing', 'deferred', 'packed', 'sent', 'cancelled', 'updated']) assert(indexSrc.includes(stage), stage);
});

check('packed actor filter/options come from local PickingOrder facts', () => {
  assert(indexSrc.includes("safeWorkflow === 'packed' && safePackedBy"));
  assert(indexSrc.includes("packedBy: { $nin: ['', null] }"));
  assert(indexSrc.includes("name: { $first: '$packedByName' }"));
});

check('metadata needed by local projection is persisted without persisting full order', () => {
  for (const token of ['sourceShopOrderId', 'sourceExternalOrderId', 'sourceDateAdd', 'sourceDateConfirmed', 'sourceDeliveryPackageModule', 'sourceDeliveryPackageNr']) {
    assert(pickingModelSrc.includes(token), token);
    assert(pickingSrc.includes(token), token);
  }
  assert(pickingSrc.includes('metadataChanged'));
});

check('packing with unresolved item problems still has no hidden bypass', () => {
  assert(!routeSrc.includes('allowIssues'));
  assert(!pickingSrc.includes('allowIssues'));
  assert(pickingSrc.includes("appError('baselinker_picking_has_unresolved_issues'"));
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(process.exitCode);
