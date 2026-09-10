#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
const pass = [];
function check(name, condition) {
  (condition ? pass : failures).push(name);
}
function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) return '';
  return source.slice(a, b);
}

const products = read('routes/products.js');
check('who-ordered imports DeliveryGroup', products.includes("const DeliveryGroup = require('../models/DeliveryGroup');"));
check('who-ordered keeps DB fallback', products.includes('groups = await DeliveryGroup.find().lean()'));

const blRoute = read('routes/baseLinker.js');
const statusBody = between(blRoute, "router.get('/status'", "router.get('/api-usage'");
check('BaseLinker status uses one raw account list', statusBody.includes('listBaseLinkerAccountRows({ includeDisabled: true })'));
check('BaseLinker status bulk-loads index states', statusBody.includes('loadIndexStates(scopes)'));
check('BaseLinker status derives scope from already-loaded row', statusBody.includes('queueScopeFromSettings(row.queue || {}, now, row)'));
check('BaseLinker status has no per-account getQueueScope', !statusBody.includes('getQueueScope('));
check('BaseLinker status has no per-account loadIndexState', !statusBody.includes('loadIndexState('));

const accounts = read('services/baseLinkerAccounts.js');
check('internal BaseLinker account rows exclude encrypted tokens', accounts.includes(".select('-tokenEncrypted')"));

const index = read('services/baseLinkerOrderIndex.js');
const bulkIndex = between(index, 'async function loadIndexStates(', 'async function saveIndexState(');
check('index state bulk loader uses one AppSetting.find', bulkIndex.includes("AppSetting.find({ key: { $in: keys } }, 'key value').lean()"));
check('index state bulk loader has no findOne', !bulkIndex.includes('findOne('));

const picking = read('services/pickingService.js');
const markPacked = between(picking, 'async function markOrderItemsPacked(', '/**\n * Atomically advance');
check('picking complete item writes use bulkWrite', markPacked.includes('Order.bulkWrite(itemUpdates'));
check('picking complete fulfilment uses updateMany', markPacked.includes('Order.updateMany('));
check('picking complete buyer notification uses one find', markPacked.includes('Order.find('));
check('picking complete has no per-order Order.updateOne', !markPacked.includes('Order.updateOne('));
check('picking complete has no per-order Order.findById', !markPacked.includes('Order.findById('));
check('short-pick semantics preserved', markPacked.includes("delivered < ordered ? 'short_pick' : null"));
check('terminal gate preserves skipped/voided semantics', markPacked.includes("skipped: { $ne: true }, voided: { $ne: true }"));
check('writes keep caller Mongo session', markPacked.includes("const opts = session ? { session } : {}"));

for (const name of pass) console.log(`PASS  ${name}`);
for (const name of failures) console.error(`FAIL  ${name}`);
console.log(`\n${pass.length}/${pass.length + failures.length} checks passed`);
if (failures.length) process.exit(1);
