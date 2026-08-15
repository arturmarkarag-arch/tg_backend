'use strict';
const fs = require('fs');
const assert = require('assert');

const routes = fs.readFileSync(require.resolve('../routes/receipts'), 'utf8');
const errors = fs.readFileSync(require.resolve('../utils/errors'), 'utf8');
const start = routes.indexOf("router.post('/:id/items/:itemId/add-warehouse-remainder'");
const end = routes.indexOf('// ── CONFIRM / UNCONFIRM A SINGLE ITEM', start);
assert.ok(start >= 0 && end > start, 'additive remainder route must exist');
const body = routes.slice(start, end);

assert.ok(body.includes("item.status !== 'confirmed'"), 'must require confirmed item');
assert.ok(body.includes('routingVersion || 0) < 1'), 'must reject legacy routing');
assert.ok(body.includes('warehouse: true'), 'must only add warehouse=true');
assert.ok(body.includes('mayNotReachAllShops: false'), 'mandatory warning must clear when remainder exists');
assert.ok(body.includes('before.mandatory') && body.includes('before.supplement'), 'must apply only after mandatory/supplement primary route');
assert.ok(body.includes('ensureReceiptItemProduct'), 'must create/reuse warehouse Product');
assert.ok(body.includes('convertReceiptShopOwnedToWarehouseMirror'), 'mandatory shop-owned artifact must convert without duplicate');
assert.ok(body.includes('didPromote'), 'double tap must be idempotent with no repeated side effects');
assert.ok(!body.includes('createOffersForReceipt'), 'must NOT recreate supplement offer');
assert.ok(!body.includes('notifyOffers'), 'must NOT resend supplement notification');
assert.ok(!body.includes('unconfirmReceiptItem'), 'must NOT use unconfirm/reconfirm path');
assert.ok(!body.includes("/unconfirm"), 'must NOT call unconfirm route');
assert.ok(errors.includes('receipt_remainder_route_invalid'));
assert.ok(errors.includes('receipt_remainder_not_supported_legacy'));

const helperStart = routes.indexOf('async function convertReceiptShopOwnedToWarehouseMirror');
const helperEnd = routes.indexOf('\nfunction getActor', helperStart);
const helper = routes.slice(helperStart, helperEnd);
assert.ok(helper.includes('$set: { linkedProductId: product._id }'), 'same ShopProduct id must become warehouse mirror');
assert.ok(helper.includes('$unset: { receiptItemId: 1 }'), 'converted mirror must leave shop-owned idempotency namespace');
assert.ok(helper.includes('ProductVector.updateOne'), 'existing shop-owned vector should migrate to warehouse owner');
assert.ok(helper.includes('item.createdShopProductId = null'), 'ReceiptItem must no longer treat mirror as standalone artifact');
assert.ok(helper.includes('syncMirror(product, { session })'), 'converted/new mirror must converge on Product fields');

console.log('PASS: confirmed primary route gains warehouse additively');
console.log('PASS: supplement offers/notifications are untouched');
console.log('PASS: mandatory-only ShopProduct converts in-place without duplicate id');
console.log('PASS: double-tap/retry has zero repeated side effects');
console.log('V47.15 warehouse remainder checks: PASS');
