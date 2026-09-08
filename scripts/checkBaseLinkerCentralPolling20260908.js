'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('services/baseLinkerOrderIndex.js');
const scheduler = read('services/baseLinkerQueueScheduler.js');
const orders = read('services/baseLinkerOrders.js');

function slice(src, startText, endText) {
  const start = src.indexOf(startText);
  assert(start >= 0, `missing start anchor: ${startText}`);
  const end = src.indexOf(endText, start + startText.length);
  assert(end > start, `missing end anchor: ${endText}`);
  return src.slice(start, end);
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}: ${error.message}`); }
}

check('Journal runtime is completely cut', () => {
  for (const forbidden of ['getJournalList', 'syncBaseLinkerJournalDelta', 'primeJournalCursor', 'queue_journal', 'journalReady', 'journalLastLogId', 'lastJournalAt']) {
    assert(!index.includes(forbidden), `index contains ${forbidden}`);
    assert(!scheduler.includes(forbidden), `scheduler contains ${forbidden}`);
  }
});

check('one backend scheduler path polls the shared queue', () => {
  assert(scheduler.includes('baselinker-queue-poll:'));
  assert(scheduler.includes('syncBaseLinkerOrderIndex({ accountId, force: false, maxAgeMs: POLL_FRESHNESS_MS })'));
  assert(scheduler.includes('timer = setInterval(tick, INDEX_REFRESH_MS)'));
  assert(!scheduler.includes('FULL_RECONCILE_MS'));
});

check('default poll cadence is 30 seconds and account-scoped', () => {
  assert(index.includes('Number(process.env.BASELINKER_QUEUE_REFRESH_MS) || 30_000'));
  assert(scheduler.includes('getAllQueueScopes({ enabledOnly: true })'));
});

check('poll performs confirmed Intake getOrders scan only', () => {
  const scan = slice(index, 'async function scanIntake', 'async function exactOrder');
  assert(scan.includes('statusId: scope.intakeStatusId'));
  assert(scan.includes('includeUnconfirmed: false'));
  assert(!scan.includes('scope.sentStatusId'));
  assert(!scan.includes('scope.cancelledStatusId'));
  assert(orders.includes("callApi('getOrders', params)"));
});

check('departures consume zero second BaseLinker request', () => {
  const transition = slice(index, 'async function reconcileIndexTransition', 'async function performIndexSync');
  assert(transition.includes('const departedIds = [...previousIds].filter((id) => !currentIds.has(id))'));
  assert(!transition.includes('await exactOrder('));
  assert(transition.includes('removedOrderIds: trackedDepartedIds'));
});

check('terminal Sent history is not part of periodic exact reverify', () => {
  const tracked = slice(index, 'async function reconcileTrackedOrderStatuses', 'async function reconcileIndexTransition');
  assert(tracked.includes("workflowStage: { $in: ['processing', 'deferred', 'packed'] }"));
  assert(!tracked.includes('sentAt'));
  const sync = slice(index, 'async function performIndexSync', 'async function syncOneAccount');
  assert(sync.includes('shouldReverifyTracked'));
  assert(sync.includes('trackedVerifiedAfter instanceof Date'));
});

check('freshness is rechecked inside distributed index lock', () => {
  const one = slice(index, 'async function syncOneAccount', 'async function syncBaseLinkerOrderIndex');
  assert(one.includes('const freshState = await loadIndexState(id, scope)'));
  assert(one.includes("reason: 'queue_poll_fresh_after_lock'"));
  assert(one.includes('if (!force && freshState.initialized'));
});

check('worker list/search/page stays Mongo-only', () => {
  const page = slice(index, 'async function getIndexedOrderPage', 'async function getLocalOrderProjection');
  assert(page.includes('READ PATH CONTRACT'));
  assert(page.includes('row?.preview'));
  assert(!page.includes('fetchBaseLinkerOrders('));
  assert(!page.includes('makeBaseLinkerAccountCaller('));
});

check('server fans changed shared projection out through socket', () => {
  assert(index.includes("emit('baselinker_orders_changed'"));
  assert(index.includes("reason: membershipChanged ? 'queue_poll_membership_changed' : 'queue_poll_data_changed'"));
  assert(index.includes('orders: membershipChanged ? [] : changedOrders'));
});

console.log(`\n${passed}/9 centralized BaseLinker polling checks passed`);
if (process.exitCode) process.exit(process.exitCode);
