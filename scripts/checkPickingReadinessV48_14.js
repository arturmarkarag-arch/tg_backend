'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let failed = 0;
const check = (ok, label) => {
  if (ok) console.log(`✅ ${label}`);
  else { failed += 1; console.error(`❌ ${label}`); }
};

console.log('V48.14 PICKING READINESS AUTHORITY');
console.log('----------------------------------');

const schedule = read('utils/orderingSchedule.js');
const picking = read('routes/picking.js');
const groups = read('routes/deliveryGroups.js');
const orderingStatus = read('services/readModels/sellerOrderingStatusReadModel.js');
const telegram = read('routes/v1/telegram.js');
const scheduler = read('services/orderingOpenScheduler.js');

check(schedule.includes('const PICKING_READY_DELAY_MS = 60 * 1000'), 'server owns the one-minute picking delay');
check(schedule.includes('function getPickingReadiness'), 'server exposes one readiness calculation');

const statusStart = groups.indexOf("router.get('/ordering-status'");
const statusEnd = groups.indexOf("router.post('/catalog-reviewed'", statusStart);
const statusBlock = groups.slice(statusStart, statusEnd);
check(statusStart >= 0 && statusBlock.includes('buildSellerOrderingStatusReadModel(req.telegramUser)'), 'ordering-status delegates to read model');
check(orderingStatus.includes('findCurrentSessionId('), 'ordering-status read model reads existing session');
check(!orderingStatus.includes('getOrCreateSessionId('), 'ordering-status read model cannot create session');

const contextStart = telegram.indexOf('async function resolveOrderingSessionContext');
const contextEnd = telegram.indexOf('\n// shopId', contextStart);
const contextBlock = telegram.slice(contextStart, contextEnd);
check(contextBlock.includes('findCurrentSessionId('), 'app bootstrap session context is read-only');
check(!contextBlock.includes('getOrCreateSessionId('), 'app bootstrap cannot materialise session');

const start = picking.indexOf("router.post('/start-session'");
const end = picking.indexOf("router.post('/cancel-start'", start);
const startBlock = picking.slice(start, end);
const gate = startBlock.indexOf('if (!readiness.pickingReady)');
const mutations = [
  'await releaseWorkerAndStaleLocks',
  'await getOrCreateSessionId',
  'await archiveOrphanedOutOfStockProducts',
  'await reconcileActiveTasksForSession',
].map((token) => startBlock.indexOf(token)).filter((n) => n >= 0);
const firstMutation = mutations.length ? Math.min(...mutations) : -1;
check(startBlock.includes('getPickingReadiness(group.orderingSchedule, commandNow)'), 'start command uses server readiness');
check(gate >= 0 && firstMutation > gate, 'readiness gate runs before operational mutation');
check(startBlock.includes('pickingNotReady: true'), 'early start is refused explicitly');

check(picking.includes('pickingReadyAt: readiness.pickingReadyAt.toISOString()'), 'picking API returns authoritative ready timestamp');
check(picking.includes('serverNow: readiness.serverNow.toISOString()'), 'picking API returns server clock reference');
check(scheduler.includes('msUntilNextMinuteBoundary()'), 'ordering scheduler aligns to minute boundary');
check(scheduler.includes('setTimeout(async () =>'), 'ordering scheduler is drift-free recursive timeout');
check(!scheduler.includes('setInterval(tick, TICK_MS)'), 'ordering scheduler no longer drifts from deploy time');

for (const rel of ['tests/pickingReadinessBoundary.test.js', 'tests/pickingReadinessAuthority.contract.test.js']) {
  const test = read(rel);
  check(!test.includes("require('vitest')"), `${rel} uses server Vitest globals`);
}

if (failed) {
  console.error(`\nV48.14 PICKING READINESS AUTHORITY: FAIL (${failed})`);
  process.exit(1);
}
console.log('\nV48.14 PICKING READINESS AUTHORITY: PASS');
