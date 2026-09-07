#!/usr/bin/env node
'use strict';
const assert = require('assert');
const {
  isProductionEligibleDisposition,
  hasLocalWarehouseSent,
  hasLocalWarehousePacked,
  lifecycleTerminalReason,
  isLifecycleTerminalSnapshot,
} = require('../domain/baseLinkerProductionLifecycle');

const cases = [
  {
    name: 'Intake is production-eligible and unfinished before warehouse Sent',
    state: { upstreamDisposition: 'intake', status: 'new', workflowStage: 'processing', upstreamReviewRequired: false },
    eligible: true, terminal: false,
  },
  {
    name: 'other status blocks production and remains unfinished',
    state: { upstreamDisposition: 'other', status: 'paused', workflowStage: 'deferred', upstreamReviewRequired: true },
    eligible: false, terminal: false,
  },
  {
    name: 'Configured Sent is terminal after canonical Sent materialization',
    state: { upstreamDisposition: 'sent', status: 'sent', workflowStage: 'sent', sentAt: new Date(), upstreamReviewRequired: false },
    eligible: false, terminal: true, reason: 'warehouse_sent',
  },
  {
    name: 'Cancelled before fulfilment is a terminal cancellation',
    state: { upstreamDisposition: 'cancelled', status: 'paused', workflowStage: 'deferred', upstreamReviewRequired: false },
    eligible: false, terminal: true, reason: 'upstream_cancelled_reviewed',
  },
  {
    name: 'Cancelled after warehouse handling remains a problem until reviewed',
    state: { upstreamDisposition: 'cancelled', status: 'packed', workflowStage: 'packed', packedAt: new Date(), upstreamReviewRequired: true },
    eligible: false, terminal: false,
  },
  {
    name: 'Packed plus other upstream status remains unfinished even after review',
    state: { upstreamDisposition: 'other', status: 'packed', workflowStage: 'packed', packedAt: new Date(), upstreamReviewRequired: false },
    eligible: false, terminal: false,
  },
  {
    name: 'Warehouse Sent plus Cancelled is a problem until reviewed',
    state: { upstreamDisposition: 'cancelled', status: 'sent', workflowStage: 'sent', sentAt: new Date(), upstreamReviewRequired: true },
    eligible: false, terminal: false,
  },
  {
    name: 'Warehouse Sent plus Cancelled becomes terminal after problem review',
    state: { upstreamDisposition: 'cancelled', status: 'sent', workflowStage: 'sent', sentAt: new Date(), upstreamReviewRequired: false },
    eligible: false, terminal: true, reason: 'warehouse_sent',
  },
  {
    name: 'Warehouse Sent plus other reviewed status keeps physical Sent terminal fact',
    state: { upstreamDisposition: 'other', status: 'sent', workflowStage: 'sent', sentAt: new Date(), upstreamReviewRequired: false },
    eligible: false, terminal: true, reason: 'warehouse_sent',
  },
  {
    name: 'An owner always keeps lifecycle unfinished',
    state: { upstreamDisposition: 'cancelled', status: 'paused', workflowStage: 'deferred', upstreamReviewRequired: false, ownerTelegramId: '123' },
    eligible: false, terminal: false,
  },
];

let passed = 0;
for (const testCase of cases) {
  const eligible = isProductionEligibleDisposition(testCase.state.upstreamDisposition);
  const terminal = isLifecycleTerminalSnapshot(testCase.state);
  assert.strictEqual(eligible, testCase.eligible, `${testCase.name}: eligibility`);
  assert.strictEqual(terminal, testCase.terminal, `${testCase.name}: terminal`);
  if (testCase.reason) assert.strictEqual(lifecycleTerminalReason(testCase.state), testCase.reason, `${testCase.name}: reason`);
  passed += 1;
  console.log(`PASS ${testCase.name}`);
}

assert.strictEqual(hasLocalWarehousePacked({ status: 'packed' }), true);
assert.strictEqual(hasLocalWarehouseSent({ status: 'packed' }), false);
assert.strictEqual(hasLocalWarehouseSent({ status: 'sent' }), true);
console.log('PASS warehouse Packed and Sent facts remain distinct');
passed += 1;

console.log(`\n${passed} BaseLinker production-lifecycle matrix checks passed`);
