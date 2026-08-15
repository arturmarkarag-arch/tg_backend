'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let failed = 0;

function check(ok, label) {
  if (ok) console.log(`✅ ${label}`);
  else {
    failed += 1;
    console.error(`❌ ${label}`);
  }
}

function getRouteSlices(source) {
  const starts = [...source.matchAll(/router\.(get|post|patch|delete)\('([^']+)'/g)]
    .map((m) => ({ method: m[1], path: m[2], start: m.index }))
    .sort((a, b) => a.start - b.start);
  return starts.map((route, idx) => ({
    ...route,
    body: source.slice(route.start, starts[idx + 1]?.start ?? source.length),
  }));
}

const picking = read('routes/picking.js');
const service = read('services/pickingService.js');
const scheduler = read('services/pickingMaintenanceScheduler.js');
const presentation = read('services/sessionPresentation.js');
const orderingScheduler = read('services/orderingOpenScheduler.js');
const index = read('index.js');

console.log('V48.13 PICKING SERVER AUTHORITY');
console.log('--------------------------------');

check(picking.includes("router.get('/session-snapshot'"), 'selected-group snapshot is a GET');

const snapshotStart = picking.indexOf('async function buildReadOnlyPickingSessionSnapshot');
const snapshotEnd = picking.indexOf('\nasync function buildTaskResponse', snapshotStart);
const snapshot = picking.slice(snapshotStart, snapshotEnd);
const forbiddenSnapshot = [
  'getOrCreateSessionId(', 'releaseWorkerAndStaleLocks(', 'findAndLockNext(',
  'archiveOrphanedOutOfStockProducts(', 'reconcileActiveTasksForSession(',
  'reconcileLateOrdersForSession(', '.updateOne(', '.updateMany(',
  '.findOneAndUpdate(', '.findByIdAndUpdate(', '.deleteMany(', '.save(',
];
check(snapshotStart >= 0 && forbiddenSnapshot.every((token) => !snapshot.includes(token)), 'session snapshot has no mutation primitive');

const getRoutes = getRouteSlices(picking).filter((r) => r.method === 'get' && r.path !== '/next-task');
const forbiddenGet = [
  /await\s+[^;\n]*\.updateOne\s*\(/,
  /await\s+[^;\n]*\.updateMany\s*\(/,
  /await\s+[^;\n]*\.findOneAndUpdate\s*\(/,
  /await\s+[^;\n]*\.findByIdAndUpdate\s*\(/,
  /await\s+[^;\n]*\.deleteMany\s*\(/,
  /await\s+[^;\n]*\.deleteOne\s*\(/,
  /getOrCreateSessionId\s*\(/,
  /releaseWorkerAndStaleLocks\s*\(/,
  /findAndLockNext\s*\(/,
  /archiveOrphanedOutOfStockProducts\s*\(/,
  /reconcileActiveTasksForSession\s*\(/,
  /reconcileLateOrdersForSession\s*\(/,
];
const dirtyGets = getRoutes.filter((route) => forbiddenGet.some((pattern) => pattern.test(route.body)));
check(dirtyGets.length === 0, `passive picking GET routes are read-only${dirtyGets.length ? ` (${dirtyGets.map((r) => r.path).join(', ')})` : ''}`);

check(picking.includes("router.post('/next-task'") && picking.includes("router.get('/next-task'"), 'next-task uses POST with one-release GET compatibility alias');
check(picking.includes('deprecated rolling-deploy alias'), 'legacy next-task GET is explicitly marked temporary');
check((picking.match(/await\s+getOrCreateSessionId\s*\(/g) || []).length === 1, 'only explicit picking start materialises a session');
check(service.includes('async function releaseStalePickingLocks') && service.includes('async function repairDuplicateWorkerLocks'), 'lock cleanup lives in server service');
check(scheduler.includes('releaseStalePickingLocks({ now })') && scheduler.includes('repairDuplicateWorkerLocks()'), 'server maintenance runs lock cleanup');
check(index.includes('startPickingMaintenanceScheduler();'), 'picking maintenance scheduler starts with server');
check(orderingScheduler.includes('materializeOpenOrderingSessions') && orderingScheduler.indexOf('materializeOpenOrderingSessions({ now })') < orderingScheduler.indexOf('notifyOrderingOpen({ now })'), 'server scheduler materialises open ordering sessions before notification/UI traffic');
check(!presentation.includes('OrderingSession.updateOne(') && scheduler.includes('repairMissingFinalSummaries'), 'presentation GET path no longer performs lazy DB repair');

if (failed) {
  console.error(`\nV48.13 PICKING SERVER AUTHORITY: FAIL (${failed})`);
  process.exit(1);
}
console.log('\nV48.13 PICKING SERVER AUTHORITY: PASS');
