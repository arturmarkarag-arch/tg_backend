'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  blankRouting,
  validateReceiptItemRouting,
  legacyDestinationForRouting,
  isNormalOrderingEnabled,
} = require('../utils/receiptRouting');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function ok(routing) {
  const result = validateReceiptItemRouting(routing);
  assert.equal(result.ok, true, `expected valid routing: ${JSON.stringify(routing)} => ${JSON.stringify(result)}`);
}
function bad(routing, reason) {
  const result = validateReceiptItemRouting(routing);
  assert.equal(result.ok, false, `expected invalid routing: ${JSON.stringify(routing)}`);
  assert.equal(result.reason, reason);
}

const warehouse = { ...blankRouting(), warehouse: true };
const mandatory = { ...blankRouting(), mandatory: true };
const mandatoryWarehouse = { ...blankRouting(), mandatory: true, warehouse: true };
const supplement = { ...blankRouting(), supplement: true, supplementDeliveryGroupId: 'group-1' };
const supplementWarehouse = { ...supplement, warehouse: true };

ok(warehouse);
ok(mandatory);
ok(mandatoryWarehouse);
ok(supplement);
ok(supplementWarehouse);
bad({ ...blankRouting(), mandatory: true, supplement: true, supplementDeliveryGroupId: 'group-1' }, 'mandatory_and_supplement');
bad({ ...blankRouting(), mayNotReachAllShops: true }, 'may_not_reach_without_mandatory');
bad({ ...mandatoryWarehouse, mayNotReachAllShops: true }, 'may_not_reach_with_warehouse');
bad({ ...blankRouting(), supplement: true }, 'supplement_group_required');
assert.equal(validateReceiptItemRouting(
  { ...blankRouting(), supplement: true },
  { allowSupplementWithoutGroup: true },
).ok, true);

assert.equal(legacyDestinationForRouting(mandatory), 'shops');
assert.equal(legacyDestinationForRouting(mandatoryWarehouse), 'shelf');
assert.equal(legacyDestinationForRouting(supplement), 'shelf');
assert.equal(isNormalOrderingEnabled(supplement), false);
assert.equal(isNormalOrderingEnabled(supplementWarehouse), true);
assert.equal(isNormalOrderingEnabled(warehouse), true);
assert.equal(isNormalOrderingEnabled(mandatory), false);

const receipts = read('routes/receipts.js');
const products = read('routes/products.js');
const orders = read('routes/orders.js');
const blocks = read('routes/blocks.js');
const blockMoveCommand = read('services/blockMoveCommand.js');
const shopUpsert = read('utils/upsertShopProduct.js');
const itemLog = read('models/ReceiptItemLog.js');
const supplementRoute = read('routes/supplement.js');
const supplementService = read('services/supplementOffers.js');
const supplementTargets = read('services/supplementTargets.js');
const supplementScheduler = read('services/supplementScheduler.js');
const supplementWaveService = read('services/supplementWaveService.js');
const supplementExclusion = read('services/supplementSessionExclusion.js');

assert(receipts.includes("router.patch('/:id/items/:itemId/routing'"));
assert(receipts.includes("status: 'draft'"));
assert(receipts.includes("action: 'routing_change'"));
assert(itemLog.includes("'routing_change'"));
assert(receipts.includes('Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty'));
assert(products.includes('firstBlockPlacedAt: { $lte: cutoff }'));
assert(blockMoveCommand.includes('activationSet.firstBlockPlacedAt = new Date()'));
assert(blocks.includes("{ source: 'receipt' }"), 'receipt products with quantity=0 must stay visible in incoming');
assert(orders.includes('product.firstBlockPlacedAt || product.shelvedAt || product.createdAt'));
assert(shopUpsert.includes('Number(item.routingVersion || 0) >= 1 ? false : true'));
assert(supplementRoute.includes('req.body?.deliveryGroupId'));
assert(supplementService.includes('filter.deliveryGroupId = String(deliveryGroupId)'));
// V48.S2: target identity is an exact current OrderingSession, not the old
// "ordinary ordering must already be closed" rule. OPEN ordering is a valid current
// delivery target; future/historical and normal completed cycles are rejected. An exact CURRENT session may reopen only from persisted CANCELLED supplement state.
assert(supplementTargets.includes('findCurrentSessionId'));
assert(supplementTargets.includes('expectedOrderingSessionId'));
assert(supplementTargets.includes('supplement_target_session_not_started'));
assert(supplementTargets.includes('supplement_target_session_completed'));
assert(supplementTargets.includes('hasReopenableSupplementCancellation'));
assert(supplementTargets.includes('status: ITEM_STATUS.CANCELLED'));
assert(receipts.includes('expectedOrderingSessionId'));
assert(receipts.includes('createWaveWithItems({'));
assert(supplementWaveService.includes('status: ITEM_STATUS.FROZEN') && supplementWaveService.includes('status: ITEM_STATUS.OPEN'), 'modern supplement item revisions have explicit server freeze');
assert(supplementService.includes('status: ITEM_STATUS.OPEN, waveId: null'), 'automatic ordinary-window freeze is legacy-only');
assert(supplementScheduler.includes('freezeOffersForActiveOrderingWindows(now)'));
assert(supplementExclusion.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE') && supplementExclusion.includes('ITEM_STATUS.COMPLETED') && supplementExclusion.includes('ITEM_STATUS.CANCELLED'), 'same-session ordinary exclusion survives completed/post-freeze supplement work');
assert(orders.includes('assertProductOrdinaryOrderable'), 'ordinary order write boundary must enforce supplement session exclusion');

const galleryStart = receipts.indexOf("router.get('/items-gallery'");
assert(galleryStart >= 0, 'photo gallery route missing');
const galleryEnd = receipts.indexOf('\nrouter.', galleryStart + 20);
const gallery = receipts.slice(galleryStart, galleryEnd > galleryStart ? galleryEnd : galleryStart + 5000);
for (const field of ['_id', 'receiptId', 'photoUrl', 'originalPhotoUrl', 'totalQty', 'destination', 'routingVersion', 'routing']) {
  assert(gallery.includes(field), `gallery must carry ${field}`);
}
assert(gallery.includes('receiptType'), 'gallery must carry legacy supplement hint');
assert(!gallery.includes(' item.price'), 'gallery must not expose price in projection');

const permissions = read('utils/receiptPermissions.js');
assert(permissions.includes("missing.push('ціна')"), 'price must gate confirmation');
assert(permissions.includes("missing.push('кількість в упаковці')"), 'package quantity must gate confirmation');
assert(receipts.includes('for (const item of items) {\n      assertItemReadyToConfirm(item, receipt);'), 'commit must revalidate readiness');
assert(receipts.includes("if (item.status === 'confirmed') {\n        assertItemReadyToConfirm(item, liveReceipt);"), 'confirmed edits must preserve readiness');

console.log('PASS receipt routing V38+: routing matrix, quantity semantics, readiness gates, incoming visibility, atomic routing, Wave/session supplement target, server freeze, ordinary-order exclusion, photo context/edit jump');
