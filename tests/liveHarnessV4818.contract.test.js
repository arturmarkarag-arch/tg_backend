'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { indexOrThrow, sliceIndexesOrThrow, sliceFromOrThrow, sliceBetweenOrThrow } = require('./helpers/sourceContract');

const DESTRUCTIVE = [
  'scripts/liveOrderPickingE2E.js',
  'scripts/liveOrderPickingMassE2E.js',
  'scripts/liveReceiptLifecycleE2E.js',
  'scripts/liveScheduleGuardE2E.js',
];

describe('V48.18 live harness hardening contract', () => {
  it('all destructive live suites share overlap guard, lease, timeout, watchdog, stable cleanup and fingerprint', () => {
    for (const rel of DESTRUCTIVE) {
      const src = read(rel);
      expect(src, rel).toContain('assertNoActiveGlobalHarnessLease');
      expect(src, rel).toContain('acquireGlobalHarnessLease');
      expect(src, rel).toContain('fetchWithTimeout');
      expect(src, rel).toContain('createProgressWatchdog');
      expect(src, rel).toContain('exitOnStallCode: 124');
      expect(src, rel).toContain('waitForStableZero');
      expect(src, rel).toContain('fingerprintCollections');
    }
  });

  it('MASS is exactly replayable and unexpected race/poll HTTP statuses are failures', () => {
    const mass = read('scripts/liveOrderPickingMassE2E.js');
    expect(mass).toContain("parseIntArg(argv, 'seed'");
    expect(mass).toContain("arg.startsWith('--cfg=')");
    expect(mass).toContain('replayCfgToken');
    expect(mass).toContain('Replay exact randomness + config:');
    expect(mass).toContain('Claim-race losers fail only with expected conflict status');
    expect(mass).toContain('Progress/complete race returns only expected success/conflict statuses');
    expect(mass).toContain('OOS/complete race returns only expected success/conflict statuses');
    expect(mass).toContain('closure.status !== 200 || locked.status !== 200');
  });

  it('contracts reject unknown scenarios and old fixtures before live mutation', () => {
    const e2e = read('scripts/liveOrderPickingE2E.js');
    expect(e2e).toContain('validateScenarioSelection(requestedScenarios');
    expect(e2e).toContain('existingTestRows === 0 && orphanManifests === 0');
    const main = sliceBetweenOrThrow(e2e, 'async function main()', '\nmain().catch', { label: 'live E2E main' });
    expect(indexOrThrow(main, 'validateScenarioSelection')).toBeLessThan(indexOrThrow(main, 'await preflight()'));
    expect(indexOrThrow(main, 'await preflight()')).toBeLessThan(indexOrThrow(main, 'acquireGlobalHarnessLease'));
  });

  it('receipt/schedule runs are crash-cleanable by exact runId and schedule guard uses DST-safe source', () => {
    const receipt = read('scripts/liveReceiptLifecycleE2E.js');
    const cleanup = read('scripts/liveOrderPickingE2ECleanup.js');
    const guard = read('scripts/liveScheduleGuardE2E.js');
    expect(receipt).toContain("kind: 'receipt'");
    expect(receipt).toContain('MANIFEST_KEY');
    expect(receipt).toContain('shops: []');
    expect(receipt).toContain("remember('shops', await Shop.create({");
    expect(receipt).toContain('isActive: true');
    expect(receipt).toContain('Shop.deleteMany({ _id: { $in: ids.shops } })');
    expect(receipt).toContain('shops: ids.shops.length ? await Shop.countDocuments');
    expect(receipt).toContain('retireTargetNeutralFixture');
    expect(receipt).toContain('supplementBatchVersion: 0');
    expect(receipt.match(/retireTargetNeutralFixture\(item\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(receipt).toContain('No unrelated target-neutral supplement items are publishable before receipt live E2E');
    expect(receipt).toContain("supplementBatchVersion: { $gte: 2 }");
    expect(cleanup).toContain('collectReceipt');
    expect(cleanup).toContain('shopIds = oidList(r.shopIds || [])');
    expect(cleanup).toContain('markerShops');
    expect(cleanup).toContain('Shop.deleteMany({ _id: { $in: ids.shopIds } })');
    expect(cleanup).toContain('removeReceipt');
    expect(cleanup).toContain('collectScheduleGuard');
    expect(cleanup).toContain('taskIds');
    expect(guard).toContain('buildScheduleGuardTestSchedules');
    expect(guard).toContain('created.taskIds');
    expect(guard).not.toContain('function splitWeekMinute');
  });

  it('real boot gate starts index.js in a disposable TEST DB and proves server-owned infra', () => {
    const boot = read('scripts/liveServerBootV48_18.js');
    expect(boot).toContain("spawn(process.execPath, ['index.js']");
    expect(boot).toContain('e2e_boot_');
    expect(boot).toContain('dropDatabase()');
    expect(boot).toContain('WEB_CONCURRENCY: \'2\'');
    expect(boot).toContain('MULTI_WORKER_REFUSAL_TIMEOUT_MS = 45_000');
    expect(boot).toContain('waitChildExit(child, MULTI_WORKER_REFUSAL_TIMEOUT_MS)');
    expect(boot).toContain('/socket.io/?EIO=4&transport=polling');
    expect(boot).toContain('socketPollingOpen');
    expect(boot).toContain("['join_picking_group'");
    expect(boot).toContain('shop_status_changed');
    expect(boot).toContain('/api/delivery-groups/catalog-reviewed');
    expect(boot).toContain("collection('orderingsessions').findOne");
    expect(boot).toContain('server-owned stale picking lock maintenance');
    expect(boot).toContain('one_active_task_per_product_group_session');
  });

  it('final live gate is sequential, includes full contracts and requires external TEST server pause', () => {
    const gate = read('scripts/runLiveReleaseGateV48_18.js');
    expect(gate).toContain('--server-paused');
    expect(gate).toContain('LIVE_E2E_EXTERNAL_SERVER_PAUSED');
    expect(gate).toContain("const isWindows = process.platform === 'win32'");
    expect(gate).toContain('shell: isWindows');
    for (const script of [
      'test:live:e2e:preflight',
      'test:live:boot:v48.18',
      'test:v35:guard',
      'test:live:receipt',
      'test:live:contracts:full',
      'test:live:race',
      'test:live:e2e:mass',
    ]) expect(gate).toContain(script);
    expect(gate.match(/test:live:e2e:preflight/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('source-contract slicing throws when either boundary disappears', () => {
    expect(() => sliceBetweenOrThrow('abc START middle END xyz', 'START', 'END')).not.toThrow();
    expect(() => sliceBetweenOrThrow('abc START only', 'START', 'END')).toThrow(/anchor missing/i);
    expect(() => sliceBetweenOrThrow('abc END before START', 'START', 'END')).toThrow();
    expect(sliceIndexesOrThrow('012345', 1, 4)).toBe('123');
    expect(() => sliceIndexesOrThrow('012345', -1, 4)).toThrow(/start index missing/i);
    expect(sliceFromOrThrow('abc START tail', 'START')).toBe('START tail');
  });
});
