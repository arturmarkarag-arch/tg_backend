'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(ok, message) {
  if (ok) {
    passed += 1;
    console.log(`✅ ${message}`);
  } else {
    failed += 1;
    console.error(`❌ ${message}`);
  }
}

function conflictResolvePayloads(rel, expectedCount) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const marker = "'/api/v1/orders/conflicts/resolve'";
  const parts = source.split(marker);
  const payloads = parts.slice(1).map((tail) => tail.slice(0, 700));
  check(payloads.length === expectedCount, `${rel}: expected ${expectedCount} conflict-resolve calls`);
  payloads.forEach((payload, index) => {
    check(payload.includes('deliveryGroupId:'), `${rel} conflict-resolve #${index + 1} carries deliveryGroupId`);
    check(payload.includes('orderingSessionId:'), `${rel} conflict-resolve #${index + 1} carries orderingSessionId`);
  });
}

conflictResolvePayloads('scripts/liveOrderPickingE2E.js', 4);
conflictResolvePayloads('scripts/liveOrderPickingMassE2E.js', 1);

console.log(`\n=== CONFLICT LIVE HARNESS SESSION ISOLATION ===`);
console.log(`${passed}/${passed + failed} PASS`);
if (failed) process.exit(1);
