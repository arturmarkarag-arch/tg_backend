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
  ['tracked Intake orders are reconciled from the shared poll and explicit review remains exact, never page-read driven', index.includes('trackedCurrentOrders') && index.includes("usageStage = 'queue_exact_verify'")],
  ['page read uses persisted sanitized preview and cached images without BaseLinker HTTP', index.includes('READ PATH CONTRACT') && index.includes('row?.preview') && index.includes('getCachedBaseLinkerProductCatalog(selectedOrders)')],
  ['raw/customer BaseLinker payload is not persisted by the index', !read('models/BaseLinkerOrderIndex.js').includes('delivery_fullname') && !read('models/BaseLinkerOrderIndex.js').includes('phone:') && !read('models/BaseLinkerOrderIndex.js').includes('email:') && read('models/BaseLinkerOrderIndex.js').includes('preview:')],
];
let pass = 0;
for (const [name, ok] of checks) {
  if (!ok) { console.error(`FAIL ${name}`); process.exitCode = 1; }
  else { console.log(`PASS ${name}`); pass += 1; }
}
console.log(`\n${pass}/${checks.length} upstream-change server checks passed`);
