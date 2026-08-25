'use strict';

// Release gate that intentionally has no DB/network side effects. It runs the
// source-level regression contracts that protect the architecture changed in
// V47.5 -> V48.2. Full Vitest and live Atlas E2E remain separate gates.
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const checks = [
  'scripts/checkWarehouseEstimateV47_5.js',
  'scripts/checkQuerySocketV47_6.js',
  'scripts/checkCoreFlowsV47_7.js',
  'scripts/checkReceiptStagedPipelineV47_10.js',
  'scripts/checkV47_12SupplementTailBlocks.js',
  'scripts/checkV47_14ReceiptPhotoComments.js',
  'scripts/checkV47_15WarehouseRemainder.js',
  'scripts/checkV47_16ReceiptBatchAndIncoming.js',
  'scripts/checkSellerCatalogOrdering.js',
  'scripts/checkV48_2SupplementGroupAtBatch.js',
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
