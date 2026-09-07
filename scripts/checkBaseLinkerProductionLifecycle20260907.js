#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const picking = read('services/baseLinkerPicking.js');
const index = read('services/baseLinkerOrderIndex.js');
const lifecycle = read('services/baseLinkerAccountLifecycle.js');
const retention = read('services/baseLinkerRetention.js');
const queue = read('services/baseLinkerQueueScope.js');
const admin = read('routes/admin.js');
const model = read('models/BaseLinkerPickingOrder.js');
const errors = read('utils/errors.js');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

check('production eligibility is strict Intake-only', () => {
  assert(picking.includes("if (disposition === 'intake') return;"));
  assert(picking.includes("throw appError('baselinker_order_not_in_intake'"));
});
check('all non-Intake upstream dispositions are exposed as blocked', () => {
  assert(picking.includes("upstreamBlocked: !isProductionEligibleDisposition(plain.upstreamDisposition)"));
  assert(picking.includes("productionEligible: isProductionEligibleDisposition(plain.upstreamDisposition)"));
});
check('leaving Intake releases owner and preserves local progress', () => {
  assert(picking.includes("upstream_ineligible_released_owner"));
  assert(picking.includes("doc.ownerTelegramId = '';"));
  assert(picking.includes("doc.workflowStage = WORKFLOW_STAGE.DEFERRED"));
});
check('release is local and cannot deadlock on upstream status', () => {
  const start = picking.indexOf('async function releasePickingOrder');
  const end = picking.indexOf('async function assertBaseLinkerPrintAllowed', start);
  const body = picking.slice(start, end);
  assert(!body.includes('requireAccountEnabled'));
  assert(!body.includes('verifyTrackedPickingOrderUpstream'));
  assert(!body.includes('assertNotUpstreamBlocked'));
  assert(body.includes("appendHistory(doc, 'order_released'"));
});
check('Packed requires fresh exact upstream verification', () => {
  const start = picking.indexOf('async function markPickingOrderPacked');
  const end = picking.indexOf('async function markPickingOrderSent', start);
  const body = picking.slice(start, end);
  assert(body.includes('force: true'));
  assert(body.includes('exactOrder'));
  assert(body.includes('verifyTrackedPickingOrderUpstream'));
  const verifier = picking.slice(picking.indexOf('async function verifyTrackedPickingOrderUpstream'), picking.indexOf('async function getPickingStates'));
  assert(verifier.includes('if (!allowBlocked) assertNotUpstreamBlocked(doc)'));
});
check('configured upstream Sent materializes the terminal local Sent outcome', () => {
  assert(picking.includes('upstream_sent_materialized'));
  assert(picking.includes("doc.status = ORDER_STATUS.SENT"));
  assert(picking.includes("doc.workflowStage = WORKFLOW_STAGE.SENT"));
  assert(picking.includes("doc.sentBy = doc.sentBy || 'system:baselinker'"));
});
check('Send never rewrites an upstream status other than Intake', () => {
  const start = picking.indexOf('async function markPickingOrderSent');
  const end = picking.indexOf('async function reopenPickingOrder', start);
  const body = picking.slice(start, end);
  assert(body.includes("if (!['intake', 'sent'].includes(disposition))"));
  assert(body.includes("if (disposition === 'intake')"));
  assert(body.includes('setBaseLinkerOrderStatus'));
});
check('warehouse Packed/Sent snapshot is immutable across upstream changes', () => {
  assert(model.includes('lastUpstreamOrderFingerprint'));
  assert(picking.includes('hasPhysicalWarehouseSnapshot'));
  assert(picking.includes('Packed snapshot is immutable'));
  assert(picking.includes('upstream_order_changed_after_fulfillment'));
});
check('admin reopen cannot erase a physical Packed/Sent fact', () => {
  const start = picking.indexOf('async function reopenPickingOrder');
  const end = picking.indexOf('async function fetchOptionalExactOrder', start);
  const body = picking.slice(start, end);
  assert(body.includes("throw appError('baselinker_physical_fulfillment_immutable')"));
  assert(errors.includes('baselinker_physical_fulfillment_immutable'));
});
check('configured Sent is rendered on the Sent shelf after canonical materialization', () => {
  const start = index.indexOf('function localDisplayStage');
  const end = index.indexOf('function pickingSearchText', start);
  const body = index.slice(start, end);
  assert(body.includes("String(doc?.status || '') === 'sent'"));
  assert(picking.includes("nextDisposition === 'sent'"));
  assert(picking.includes("doc.workflowStage = WORKFLOW_STAGE.SENT"));
});
check('pre-claim departure from Intake is materialized for every non-Intake disposition including Sent', () => {
  const start = picking.indexOf('async function markPickingOrdersUpstreamUpdated');
  const end = picking.indexOf('async function acknowledgeUpstreamReview', start);
  const body = picking.slice(start, end);
  assert(body.includes("if (disposition !== 'intake')"));
  assert(!body.includes("!['intake', 'sent'].includes(disposition)"));
});
check('review acknowledgment can resolve upstream cancellation without inventing local Sent', () => {
  const start = picking.indexOf('async function acknowledgeUpstreamReview');
  const end = picking.indexOf('async function reconcilePickingFromUpstreamChanges', start);
  const body = picking.slice(start, end);
  assert(body.includes('doc.upstreamReviewRequired = false'));
  assert(!body.includes('ORDER_STATUS.SENT'));
});
check('unresolved or recently changed upstream problems are protected from retention', () => {
  assert(retention.includes("upstreamReviewRequired: { $ne: true }"));
  assert(retention.includes("lastUpstreamChangeAt: { $lt: cutoffDate }"));
  assert(retention.includes("old sentAt alone must never erase a recently resolved conflict"));
});
check('materialized Sent and reviewed Cancelled are retention terminal candidates', () => {
  const start = retention.indexOf('function terminalPickingCandidateFilter');
  const end = retention.indexOf('async function purgeVerifiedTerminalPickingForAccount', start);
  const body = retention.slice(start, end);
  assert(body.includes("status: 'sent'"));
  assert(body.includes("{ upstreamDisposition: 'cancelled'"));
});
check('tracked orders keep exact status reconciliation after leaving Intake', () => {
  assert(index.includes('async function reconcileTrackedOrderStatuses'));
  assert(index.includes('TRACKED_REVERIFY_LIMIT'));
  assert(index.includes('lastUpstreamVerifiedAt'));
  assert(index.includes('reconcileTrackedOrderStatuses(scope, { force: forceReverify, verifiedAfter: trackedVerifiedAfter })'));
  assert(index.includes('forceReverify: force, trackedVerifiedAfter'));
  assert(index.includes('if (verifiedBoundary)'));
  assert(index.includes('VISIBLE_TRACKED_REVERIFY_LIMIT'));
});

check('manual force sync bypasses tracked verification TTL so status changes are observable immediately', () => {
  assert(index.includes('forceReverify: force, trackedVerifiedAfter'));
  assert(index.includes('reconcileTrackedOrderStatuses(scope, { force: forceReverify, verifiedAfter: trackedVerifiedAfter })'));
});
check('lifecycle reconciliation makes bounded forward progress instead of rechecking the same rows forever', () => {
  assert(lifecycle.includes('LIFECYCLE_TRACKED_FRESH_MS'));
  assert(lifecycle.includes('LIFECYCLE_TRACKED_VERIFY_MAX'));
  assert(lifecycle.includes('verifiedAfter = new Date(Date.now() - LIFECYCLE_TRACKED_FRESH_MS)'));
  assert(lifecycle.includes('while (trackedPending > 0 && trackedChecked < LIFECYCLE_TRACKED_VERIFY_MAX)'));
  assert(lifecycle.includes('verifiedAfter,'));
});
check('account disable checks Intake index, unfinished workflow and active print jobs', () => {
  assert(lifecycle.includes('BaseLinkerOrderIndex.countDocuments'));
  assert(lifecycle.includes('BaseLinkerPickingOrder.countDocuments'));
  assert(lifecycle.includes("status: { $in: ['pending', 'claimed', 'printing'] }"));
});
check('cancelled plus reviewed is lifecycle-terminal while unresolved cancellation is not', () => {
  assert(lifecycle.includes('{ upstreamReviewRequired: true }'));
  assert(lifecycle.includes("upstreamDisposition: { $ne: 'cancelled' }"));
});
check('disable and claim share one account lifecycle synchronization boundary', () => {
  assert(lifecycle.includes('withBaseLinkerAccountLifecycleLock'));
  const claim = picking.slice(picking.indexOf('async function claimPickingOrder'), picking.indexOf('async function heartbeatPickingOrder'));
  assert(claim.includes('withBaseLinkerAccountLifecycleLock(accountId'));
});
check('disable is based on fresh Intake plus complete tracked reconciliation and fails closed', () => {
  assert(lifecycle.includes('async function refreshBaseLinkerLifecycleTruth'));
  assert(lifecycle.includes("trackedVerifiedAfter: verifiedAfter"));
  assert(lifecycle.includes('trackedReverifyPending'));
  assert(lifecycle.includes("baselinker_lifecycle_reconciliation_incomplete"));
  assert(admin.includes('disableBaseLinkerAccount'));
});
check('queue status IDs cannot change while production lifecycle has blockers or incomplete truth', () => {
  assert(queue.includes("assertBaseLinkerAccountLifecycleIdle(id, 'queue')"));
  assert(queue.includes('refreshBaseLinkerLifecycleTruth(id)'));
  assert(queue.includes('withBaseLinkerAccountLifecycleLock'));
});
check('API token rotation remains separate from lifecycle blocking', () => {
  const start = admin.indexOf("router.post('/baselinker-settings/accounts/:accountId/token'");
  const end = admin.indexOf("router.post('/baselinker-settings/accounts/:accountId/refresh'", start);
  const body = admin.slice(start, end);
  assert(body.includes('rotateBaseLinkerToken'));
  assert(!body.includes('assertBaseLinkerAccountLifecycleIdle'));
});
check('acknowledged upstream review stays closed until a new upstream event occurs', () => {
  assert(picking.includes('function upstreamReviewAlreadyAcknowledged'));
  assert(picking.includes('!orderChanged && !statusChanged'));
  assert(picking.includes('!upstreamReviewAlreadyAcknowledged(doc)'));
  assert(picking.includes('statusChanged: upstreamState.changed === true'));
  assert(picking.includes('orderChanged: sync.changed === true'));
});
check('TTN access exact-verifies terminal statuses and requires explicit server confirmation', () => {
  const routes = read('routes/baseLinker.js');
  const printService = read('services/baseLinkerPrint.js');
  const errors = read('utils/errors.js');
  assert(picking.includes('async function assertBaseLinkerPrintAllowed'));
  assert(picking.includes("disposition === 'sent' || disposition === 'cancelled'"));
  assert(picking.includes('baselinker_terminal_ttn_confirmation_required'));
  assert(picking.includes('confirmedDisposition'));
  assert(routes.includes("confirmTerminalTtn: String(req.query.confirmTerminalTtn || '') === '1'"));
  assert(routes.includes('confirmedDisposition: req.query.confirmedDisposition'));
  assert(routes.includes('confirmTerminalTtn: req.body?.confirmTerminalTtn === true'));
  assert(printService.includes('await assertBaseLinkerPrintAllowed({'));
  assert(errors.includes('baselinker_terminal_ttn_confirmation_required'));
});
check('hard-delete endpoint is intentionally absent', () => {
  assert(!/router\.delete\(['"]\/baselinker-settings\/accounts/.test(admin));
});

console.log(`\n${passed} backend BaseLinker production-lifecycle checks passed`);
if (process.exitCode) process.exit(process.exitCode);
