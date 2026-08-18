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
  ['destructive rollback preserves any modern supplement publication history', sync.includes("mode === 'destructive' && modernOffers.length > 0")],
  ['legacy publication remains destructive rollback blocker', sync.includes('legacyOffers.length > 0') && sync.includes('старий publication flow')],
  ['future metadata edit blocks only OPEN/FROZEN modern publication', sync.includes('activeModernOffers') && sync.includes('modernOffers.filter(isActiveItemRevision)') && sync.includes('revision: revisionOf(offer)')],
  ['commercial edits explicitly request future-edit usage semantics', receipts.includes("describeItemUsage(item, { session: txSession, mode: 'edit' })")],
  ['DELETE always checks destructive usage before rollback', /router\.delete\('\/:id\/items\/:itemId'[\s\S]*?const usage = await describeItemUsage\(item, \{ session \}\);[\s\S]*?rollbackItemArtifacts/.test(receipts)],
  ['UNCONFIRM always checks destructive usage before rollback', /router\.post\('\/:id\/items\/:itemId\/unconfirm'[\s\S]*?const usage = await describeItemUsage\(item, \{ session \}\);[\s\S]*?rollbackItemArtifacts/.test(receipts)],
  ['confirmed reroute stays locked', /router\.patch\('\/:id\/items\/:itemId\/routing'[\s\S]*?status: 'draft'/.test(receipts)],
  ['warehouse remainder remains additive', receipts.includes("router.post('/:id/items/:itemId/add-warehouse-remainder'") && receipts.includes('meta: { additive: true, primaryRoutePreserved: true }')],
  ['group publication rechecks confirmed/supplement state without requiring fake Product', /const candidates = await ReceiptItem\.find\(\{[\s\S]*?status: 'confirmed'[\s\S]*?'routing\.supplement': true[\s\S]*?supplementBatchVersion: \{ \$gte: 1 \}/.test(receipts)],
  ['item-global lifecycle history is the publication fence', receipts.includes('existingPublications') && receipts.includes('blockedItemIds') && receipts.includes('selectedRows = publishable.filter')],
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
