'use strict';

const assert = require('node:assert/strict');
const {
  parseOptionalNonNegativeNumber,
  parseOptionalNonNegativeInteger,
  retryDelayMs,
  shouldReuseRotatedTokenAfterForcedRefresh,
} = require('../services/allegroRuntimePolicy');

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}

check('missing Retry-After stays missing instead of coercing null to zero', () => {
  assert.equal(parseOptionalNonNegativeNumber(null), null);
  assert.equal(parseOptionalNonNegativeNumber(undefined), null);
  assert.equal(parseOptionalNonNegativeNumber(''), null);
  assert.equal(parseOptionalNonNegativeNumber('   '), null);
});

check('explicit zero Retry-After remains a valid explicit delay', () => {
  assert.equal(parseOptionalNonNegativeNumber(0), 0);
  assert.equal(parseOptionalNonNegativeNumber('0'), 0);
});

check('transient retry without Retry-After uses exponential backoff', () => {
  assert.equal(retryDelayMs({ attempt: 1, retryAfterMs: null, random: () => 0 }), 250);
  assert.equal(retryDelayMs({ attempt: 2, retryAfterMs: undefined, random: () => 0 }), 500);
  assert.equal(retryDelayMs({ attempt: 3, retryAfterMs: null, random: () => 0 }), 1000);
});

check('explicit Retry-After overrides exponential backoff', () => {
  assert.equal(retryDelayMs({ attempt: 3, retryAfterMs: 1750, random: () => 0 }), 1750);
});

check('missing rejected token revision remains null', () => {
  assert.equal(parseOptionalNonNegativeInteger(null), null);
  assert.equal(parseOptionalNonNegativeInteger(undefined), null);
  assert.equal(parseOptionalNonNegativeInteger(''), null);
});

check('real rejected token revisions remain numeric', () => {
  assert.equal(parseOptionalNonNegativeInteger(0), 0);
  assert.equal(parseOptionalNonNegativeInteger('4'), 4);
  assert.equal(parseOptionalNonNegativeInteger(4.5), null);
  assert.equal(parseOptionalNonNegativeInteger(-1), null);
});

check('forceRefresh without rejected revision never reuses the current token', () => {
  assert.equal(shouldReuseRotatedTokenAfterForcedRefresh({
    forceRefresh: true,
    rejectedTokenRevision: null,
    currentTokenRevision: 7,
    tokenUsable: true,
  }), false);
});

check('401 recovery reuses only a token rotated past the rejected revision', () => {
  assert.equal(shouldReuseRotatedTokenAfterForcedRefresh({
    forceRefresh: true,
    rejectedTokenRevision: 7,
    currentTokenRevision: 8,
    tokenUsable: true,
  }), true);
  assert.equal(shouldReuseRotatedTokenAfterForcedRefresh({
    forceRefresh: true,
    rejectedTokenRevision: 7,
    currentTokenRevision: 7,
    tokenUsable: true,
  }), false);
});

console.log(`Allegro runtime policy: ${checks.length}/${checks.length} PASS`);
