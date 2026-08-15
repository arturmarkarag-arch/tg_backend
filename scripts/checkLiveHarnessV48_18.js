'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const checks = [];
function check(ok, name, details = '') {
  checks.push({ ok: Boolean(ok), name, details });
  console.log(`${ok ? '✅' : '❌'} ${name}${details ? ` — ${details}` : ''}`);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const contracts = read('scripts/liveOrderPickingE2E.js');
const mass = read('scripts/liveOrderPickingMassE2E.js');
const receipt = read('scripts/liveReceiptLifecycleE2E.js');
const guard = read('scripts/liveScheduleGuardE2E.js');
const cleanup = read('scripts/liveOrderPickingE2ECleanup.js');
const safety = read('scripts/helpers/liveHarnessSafety.js');
const schedule = read('scripts/helpers/perGroupTestSchedule.js');
const boot = read('scripts/liveServerBootV48_18.js');
const gate = read('scripts/runLiveReleaseGateV48_18.js');
const pkg = JSON.parse(read('package.json'));

for (const [name, source] of [['contracts', contracts], ['mass', mass], ['receipt', receipt], ['schedule-guard', guard]]) {
  check(source.includes('fetchWithTimeout'), `${name}: HTTP calls use timeout wrapper`);
  check(source.includes('assertNoActiveGlobalHarnessLease'), `${name}: preflight rejects overlapping live run`);
  check(source.includes('acquireGlobalHarnessLease'), `${name}: destructive live run uses global TEST-Atlas lease`);
  check(source.includes('createProgressWatchdog'), `${name}: no-progress watchdog is active`);
  check(source.includes('exitOnStallCode: 124'), `${name}: a truly hung DB/socket promise hard-fails instead of hanging forever`);
  check(source.includes('waitForStableZero'), `${name}: cleanup requires a quiet stable-zero window`);
  check(source.includes('fingerprintCollections'), `${name}: unrelated TEST data is fingerprinted`);
}

check(contracts.includes('validateScenarioSelection(requestedScenarios'), 'contracts: unknown/empty --scenario fails closed');
check(contracts.includes('existingTestRows === 0 && orphanManifests === 0'), 'contracts: old fixtures/manifests are a hard preflight failure');
check(mass.includes("parseIntArg(argv, 'seed'"), 'MASS: --seed replay is supported');
check(mass.includes('parseReplayConfig(argv)'), 'MASS: replay also freezes topology/concurrency config');
check(mass.includes('Replay exact randomness + config:'), 'MASS: report/log prints exact seed+config replay command');
check(mass.includes("status === 200 || r.status === 409"), 'MASS: claim-race loser statuses are explicit');
check(mass.includes('[200, 403, 409].includes(status)'), 'MASS: progress/complete race rejects unexpected HTTP statuses');
check(mass.includes('[200, 403, 404, 409].includes(status)'), 'MASS: OOS/complete race rejects unexpected HTTP statuses');
check(mass.includes('closure.status !== 200 || locked.status !== 200'), 'MASS: background polling requires HTTP 200, not merely non-500');
check(mass.includes("phaseStart('final_integrity')") && mass.includes('## Phase durations'), 'MASS: post-picking verification is timed/reported instead of looking like an unexplained hang');
check(receipt.includes("kind: 'receipt'"), 'receipt: crash-safe run manifest is persisted');
check(receipt.includes('cleanup/fingerprint pending') && receipt.includes('cleanup stable · unrelated data unchanged'), 'receipt: final PASS is emitted only after cleanup/fingerprint succeeds');
check(cleanup.includes('collectReceipt') && cleanup.includes('removeReceipt'), 'cleanup: exact runId cleanup supports receipt manifests');
check(cleanup.includes("User.find({ firstName: 'LiveReceipt', lastName: runId }") && cleanup.includes("Product.find({ $or: [{ name: marker }, { brand: marker }] }"), 'cleanup: receipt marker fallback closes create-before-manifest crash windows');
check(cleanup.includes("User.find({ telegramId: `v35guard-${runId}` }") && cleanup.includes('markerGroups'), 'cleanup: schedule-guard marker fallback closes create-before-manifest crash windows');
check(cleanup.includes('collectScheduleGuard') && cleanup.includes('taskIds'), 'cleanup: schedule-guard exact IDs survive partial/corrupted group scope');
check(cleanup.includes('waitForStableZero'), 'cleanup: crash cleanup also verifies stable zero');
check(cleanup.includes('force-active-owner') && cleanup.includes('fresh lease heartbeat'), 'cleanup: refuses to delete beneath a still-heartbeating run unless operator forces it');
check(guard.includes('buildScheduleGuardTestSchedules'), 'schedule guard: uses shared DST-safe fixture builder');
check(!guard.includes('function splitWeekMinute'), 'schedule guard: old manual week-minute arithmetic is gone');
check(schedule.includes('buildScheduleGuardTestSchedules'), 'fixture helper: schedule-guard builder is centralized');
check(safety.includes('GLOBAL_LOCK_KEY') && safety.includes('live-e2e.global-lock'), 'safety helper: one-live-harness-at-a-time lease exists');
check(safety.includes('assertNoActiveGlobalHarnessLease'), 'safety helper: active lease can be detected read-only during preflight');
check(safety.includes('LIVE_E2E_HTTP_TIMEOUT'), 'safety helper: HTTP timeout failures are explicit');
check(safety.includes('LIVE_E2E_STALLED'), 'safety helper: progress watchdog produces a dedicated stall failure');
check(safety.includes('process.exit(exitOnStallCode)'), 'safety helper: watchdog can escape a non-cancellable hung promise');

// Real process boot: this is intentionally NOT another require('../app') smoke.
check(boot.includes("spawn(process.execPath, ['index.js']"), 'boot gate: starts the real server/index.js process');
check(boot.includes('e2e_boot_') && boot.includes('dropDatabase()'), 'boot gate: uses and drops a unique temporary TEST database');
check(boot.includes('WEB_CONCURRENCY: \'2\'') && boot.includes('without Redis'), 'boot gate: proves unsafe multi-worker/no-Redis startup is refused');
check(boot.includes('/socket.io/?EIO=4&transport=polling'), 'boot gate: proves Socket.IO polling transport is actually alive');
check(boot.includes('socketPollingOpen') && boot.includes("['join_picking_group'") && boot.includes('shop_status_changed'), 'boot gate: authenticates a socket, joins a group room and waits for a real event');
check(boot.includes('/api/delivery-groups/catalog-reviewed'), 'boot gate: HTTP route actually triggers the socket event');
check(boot.includes('server-owned OrderingSession materialisation'), 'boot gate: waits for server-owned session creation without Mini App traffic');
check(boot.includes('server-owned stale picking lock maintenance'), 'boot gate: waits for server-owned picking maintenance');
check(boot.includes('OrderingSession groupId+openDate unique index'), 'boot gate: verifies critical session index after actual startup');

check(gate.includes("['real-server-boot', 'test:live:boot:v48.18']"), 'release gate includes real server boot smoke');
check(gate.includes("['contracts-full', 'test:live:contracts:full']"), 'release gate runs every exact contract scenario, not only the old subset');
check(gate.includes("['preflight-after', 'test:live:e2e:preflight']"), 'release gate ends with a clean preflight');
check(gate.includes('LIVE_E2E_EXTERNAL_SERVER_PAUSED'), 'release gate refuses destructive shared-DB run without explicit external-server pause acknowledgement');
check(!String(pkg.scripts['test:live:contracts:full'] || '').includes('--scenario='), 'full contracts npm command has no scenario filter');
check(String(pkg.scripts['test:live:boot:v48.18'] || '').includes('-r ../dev-use-test-db.js'), 'real boot npm command is protected by TEST DB preload');

// The V48.16 class of false failures/false greens came from source.slice(indexOf(...))
// with a missing -1 anchor. Keep one algorithmic indexOf test explicitly exempt;
// all source-contract tests must use sourceContract helpers now.
const testFiles = walk(path.join(ROOT, 'tests')).filter((file) => /(?:\.contract)?\.test\.js$/.test(file));
const unsafeIndexFiles = [];
for (const file of testFiles) {
  if (file.endsWith(`${path.sep}sellerVisualOrderingAlgo.test.js`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('.indexOf(')) unsafeIndexFiles.push(path.relative(ROOT, file));
}
check(unsafeIndexFiles.length === 0, 'server source-contract tests have no raw indexOf anchors', unsafeIndexFiles.join(', '));

const failed = checks.filter((x) => !x.ok);
console.log(`\n=== V48.18 LIVE HARNESS STATIC ===`);
console.log(`${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exitCode = 1;
