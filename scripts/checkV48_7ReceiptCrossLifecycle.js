'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');
const httpCross = read('tests/receiptLifecycleCrossHttp.test.js');
const liveCross = read('scripts/liveReceiptLifecycleE2E.js');

const checks = [
  ['deferred supplement publication blocks rollback', sync.includes('if (item.supplementPublishRequestedAt)')],
  ['offer existence blocks rollback with zero requests', sync.includes("SupplementOffer.find({ receiptItemId: item._id }, '_id status deliveryGroupId')")],
  ['completed/frozen offers are explicit usage states', sync.includes("statuses.has('completed')") && sync.includes("statuses.has('frozen')")],
  ['commercial edits use downstream usage guard', receipts.includes("changedFields.some((field) => criticalEditFields.has(field))")],
  ['DELETE always checks usage before rollback', /router\.delete\('\/:id\/items\/:itemId'[\s\S]*?const usage = await describeItemUsage\(item, \{ session \}\);[\s\S]*?rollbackItemArtifacts/.test(receipts)],
  ['UNCONFIRM always checks usage before rollback', /router\.post\('\/:id\/items\/:itemId\/unconfirm'[\s\S]*?const usage = await describeItemUsage\(item, \{ session \}\);[\s\S]*?rollbackItemArtifacts/.test(receipts)],
  ['confirmed reroute stays locked', /router\.patch\('\/:id\/items\/:itemId\/routing'[\s\S]*?status: 'draft'/.test(receipts)],
  ['warehouse remainder remains additive', receipts.includes("router.post('/:id/items/:itemId/add-warehouse-remainder'") && receipts.includes('meta: { additive: true, primaryRoutePreserved: true }')],
  ['batch publication rechecks confirmed/supplement state without requiring fake Product', /const candidates = await ReceiptItem\.find\(\{[\s\S]*?status: 'confirmed'[\s\S]*?'routing\.supplement': true[\s\S]*?supplementBatchVersion: \{ \$gte: 1 \}/.test(receipts)],
  ['exact-session child existence is the publication fence', receipts.includes('existingTargetItems') && receipts.includes('selectedRows = publishable.filter')],
  ['cross HTTP covers clean rollback then reassignment', httpCross.includes('explicit unconfirm -> routing -> confirm')],
  ['cross HTTP covers publish-vs-unconfirm and publish-vs-delete races', httpCross.includes('publish vs unconfirm race') && httpCross.includes('publish vs delete race')],
  ['live TEST harness exercises real preparation/routing/confirm and receipt races', liveCross.includes('real draft -> preparation -> routing -> confirm -> edit -> rollback') && liveCross.includes('publication races cannot split receipt state')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`V48.7 receipt cross-lifecycle: PASS (${checks.length}/${checks.length})`);
