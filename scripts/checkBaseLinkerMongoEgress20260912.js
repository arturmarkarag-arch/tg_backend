'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'services/baseLinkerOrderIndex.js'), 'utf8');
const model = fs.readFileSync(path.join(root, 'models/BaseLinkerOrderIndex.js'), 'utf8');

const checks = [
  ['full durable writes are change-filtered', service.includes('const rowsNeedingFullWrite = rows.filter')],
  ['full bulkWrite uses only changed/new rows', service.includes('BaseLinkerOrderIndex.bulkWrite(rowsNeedingFullWrite.map')],
  ['old every-row full bulkWrite is absent', !service.includes('BaseLinkerOrderIndex.bulkWrite(rows.map')],
  ['previous persisted row includes searchText for comparison', service.includes(".select('orderId orderIdNumeric orderSortDate sourceType sourceId preview searchText')")],
  ['poll freshness uses one compact heartbeat updateMany', service.includes('await BaseLinkerOrderIndex.updateMany(') && service.includes("orderId: { $in: [...currentIds] }")],
  ['heartbeat preserves seenAt semantics', service.includes('seenAt: now')],
  ['syncToken is heartbeat-only on explicit reset', service.includes('...(resetIndex ? { syncToken } : {})')],
  ['reset cleanup still deletes rows not marked by current reset', service.includes("deleteMany({ baseLinkerAccountId: accountId, syncToken: { $ne: syncToken } })")],
  ['durable model still carries seenAt', model.includes('seenAt: { type: Date')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.error(`FAIL ${name}`); }
}
console.log(`\n${checks.length - failed}/${checks.length} BaseLinker Mongo egress checks passed`);
if (failed) process.exit(1);
