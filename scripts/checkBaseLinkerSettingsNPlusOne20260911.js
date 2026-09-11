#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const admin = read('routes/admin.js');
const lifecycle = read('services/baseLinkerAccountLifecycle.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('BaseLinker settings uses one batched lifecycle lookup for all accounts', () => {
  const start = admin.indexOf("router.get('/baselinker-settings'");
  const end = admin.indexOf("router.post('/baselinker-settings/validate'", start);
  const body = admin.slice(start, end);
  assert(body.includes('getBaseLinkerAccountLifecycleBlockersBatch'));
  assert(body.includes('accounts.map((account) => account.accountId)'));
  assert(!body.includes('getBaseLinkerAccountLifecycleBlockers(account.accountId)'));
  assert(!body.includes('Promise.all(accounts.map(async'));
});

check('batched lifecycle lookup is constant-query across account count', () => {
  const start = lifecycle.indexOf('async function getBaseLinkerAccountLifecycleBlockersBatch');
  const end = lifecycle.indexOf('async function getBaseLinkerAccountLifecycleBlockers(accountId)', start);
  const body = lifecycle.slice(start, end);
  assert(body.includes('if (!ids.length) return result;'));
  assert.strictEqual((body.match(/\.aggregate\(\[/g) || []).length, 3);
  assert(body.includes("baseLinkerAccountId: { $in: ids }"));
  assert(body.includes("_id: '$baseLinkerAccountId'"));
});

check('batched lifecycle lookup preserves all three blocker classes', () => {
  const start = lifecycle.indexOf('async function getBaseLinkerAccountLifecycleBlockersBatch');
  const end = lifecycle.indexOf('async function getBaseLinkerAccountLifecycleBlockers(accountId)', start);
  const body = lifecycle.slice(start, end);
  assert(body.includes('BaseLinkerOrderIndex.aggregate'));
  assert(body.includes('BaseLinkerPickingOrder.aggregate'));
  assert(body.includes('BaseLinkerPrintJob.aggregate'));
  assert(body.includes("status: { $in: ['pending', 'claimed', 'printing'] }"));
  assert(body.includes('$or: unfinishedPickingConditions()'));
});

check('single-account lifecycle guard remains available for disable/queue safety', () => {
  assert(lifecycle.includes('async function getBaseLinkerAccountLifecycleBlockers(accountId)'));
  assert(lifecycle.includes('BaseLinkerOrderIndex.countDocuments'));
  assert(lifecycle.includes('BaseLinkerPickingOrder.countDocuments'));
  assert(lifecycle.includes('BaseLinkerPrintJob.countDocuments'));
});

console.log(`\n${passed} BaseLinker settings N+1 checks passed`);
if (process.exitCode) process.exit(process.exitCode);
