#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'baseLinkerPicking.js'), 'utf8');
const start = source.indexOf('function upstreamReviewAlreadyAcknowledged');
const end = source.indexOf('function assertRevision', start);
assert(start >= 0 && end > start, 'review helper block not found');
const helperSource = source.slice(start, end);

const sandbox = {
  Date,
  hasWarehouseHandling: (doc) => doc?.handled === true,
  hasLocalWarehouseSent: (doc) => doc?.sent === true,
};
vm.createContext(sandbox);
vm.runInContext(`${helperSource}\nthis.shouldRequireUpstreamReview = shouldRequireUpstreamReview;`, sandbox);
const shouldRequire = sandbox.shouldRequireUpstreamReview;

const at = (ms) => new Date(ms);
const sameOtherPending = {
  upstreamReviewRequired: true,
  lastUpstreamChangeAt: at(1000),
  upstreamReviewedAt: null,
};
assert.strictEqual(shouldRequire(sameOtherPending, 'other'), true, 'unreviewed current event must remain visible');

const sameOtherReviewed = {
  upstreamReviewRequired: false,
  lastUpstreamChangeAt: at(1000),
  upstreamReviewedAt: at(2000),
};
assert.strictEqual(shouldRequire(sameOtherReviewed, 'other'), false, 'acknowledged unchanged event must stay closed');
assert.strictEqual(shouldRequire(sameOtherReviewed, 'other', { statusChanged: true }), true, 'new status event must reopen review');
assert.strictEqual(shouldRequire(sameOtherReviewed, 'other', { orderChanged: true }), true, 'new order-content event must reopen review');
assert.strictEqual(shouldRequire({ handled: false }, 'cancelled', { statusChanged: true }), false, 'clean pre-handling cancellation needs no manual review');
assert.strictEqual(shouldRequire({ handled: true }, 'cancelled', { statusChanged: true }), true, 'cancellation after warehouse handling requires review');
assert.strictEqual(shouldRequire({ sent: true }, 'intake', { statusChanged: true }), true, 'Sent -> Intake conflict requires review');

console.log('PASS acknowledged review does not resurrect without a new upstream event');
console.log('PASS new status/order events reopen review');
console.log('PASS cancellation and Sent->Intake conflict semantics');
console.log('\n3 BaseLinker upstream-review acknowledgement checks passed');
