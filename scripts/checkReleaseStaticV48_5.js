'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const checks = [
  'scripts/checkWarehouseEstimateV47_5.js',
  'scripts/checkQuerySocketV47_6.js',
  'scripts/checkCoreFlowsV47_7.js',
  'scripts/checkReceiptStagedPipelineV47_10.js',
  'scripts/checkReceiptMassIntake20260828.js',
  'scripts/checkV47_12SupplementTailBlocks.js',
  'scripts/checkV47_14ReceiptPhotoComments.js',
  'scripts/checkV47_15WarehouseRemainder.js',
  'scripts/checkV47_16ReceiptBatchAndIncoming.js',
  'scripts/checkSellerCatalogOrdering.js',
  'scripts/checkV48_2SupplementGroupAtBatch.js',
  'scripts/checkV48_4LiveHarness.js',
  'scripts/checkV48_5TestDbSafety.js',
  'scripts/checkV48_7ReceiptCrossLifecycle.js',
  'scripts/checkV48_8WarsawDatePolicy.js',
  'scripts/checkPhotoEgressV48_11.js',
  'scripts/checkPhotoEgressV48_12.js',
  'scripts/checkPickingServerAuthorityV48_13.js',
  'scripts/checkPickingReadinessV48_14.js',
  'scripts/checkLiveHarnessV48_18.js',
  'scripts/checkDataStateArchitectureV48_19.js',
  'scripts/checkMutationAuthorityV48_20.js',
  'scripts/checkOperationalReadModelsV48_21.js',
  'scripts/checkSupplementContainerArchitectureV48_S3.js',
  'scripts/checkSupplementRevisionCyclesV48_S3.js',
  'scripts/checkSupplementMetadataAuthorityV48_S3_1.js',
  'scripts/checkReceiptSupplementLifecycle20260821.js',
  'scripts/checkOrderUnassignState.js',
  'scripts/checkConflictLiveHarnessSessionIsolation.js',
  'scripts/checkTelegramDeliveryLedgerV48.js',
  'scripts/checkOrderingReminderDeliveryV48.js',
];

let failed = 0;
for (const rel of checks) {
  console.log(`\n=== ${rel} ===`);
  const result = spawnSync(process.execPath, [path.join(root, rel)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL: ${rel} exited with ${result.status ?? 'unknown'}`);
  }
}

if (failed) {
  console.error(`\nRELEASE STATIC GATE: FAIL (${failed}/${checks.length} checks failed)`);
  process.exit(1);
}
console.log(`\nRELEASE STATIC GATE: PASS (${checks.length}/${checks.length})`);
