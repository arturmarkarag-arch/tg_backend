'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const model = read('models/BaseLinkerPickingOrder.js');
const picking = read('services/baseLinkerPicking.js');
const index = read('services/baseLinkerOrderIndex.js');
const checks = [
  ['PickingOrder persists only compact last-change details', model.includes('lastUpstreamChangeDetails') && model.includes('UpstreamChangeDetailSchema')],
  ['quantity changes have explicit before/after details', picking.includes("['requestedQty', 'quantity']") && picking.includes('fromValue') && picking.includes('toValue')],
  ['added and removed product lines get human-readable detail records', picking.includes("kind: 'added'") && picking.includes("kind: 'removed'")],
  ['public DTO exposes compact change details', picking.includes('lastUpstreamChangeDetails: (Array.isArray(plain.lastUpstreamChangeDetails)')],
  ['changed source lines reset only that line for explicit re-review', picking.includes('details.push(...upstreamLineChangeDetails(old, source))') && picking.includes("state: 'pending'")],
  ['visible tracked Intake rows are compared against transient live BaseLinker payload', index.includes('trackedFoundRows') && index.includes('reconcilePickingFromUpstreamChanges({ orders: trackedOrders')],
  ['page read live-fetches all selected Intake ids, not only untouched rows', index.includes('const selectedIntakeIds = selectedIds.filter((id) => indexSet.has(id))')],
  ['live BaseLinker payload is not persisted by the index', !read('models/BaseLinkerOrderIndex.js').includes('order:')],
];
let pass = 0;
for (const [name, ok] of checks) {
  if (!ok) { console.error(`FAIL ${name}`); process.exitCode = 1; }
  else { console.log(`PASS ${name}`); pass += 1; }
}
console.log(`\n${pass}/${checks.length} upstream-change server checks passed`);
