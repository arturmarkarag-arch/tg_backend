'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}
function yes(v, m) { if (!v) throw new Error(m); }
function no(v, m) { if (v) throw new Error(m); }
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');
const command = read('services/receiptCommercialMetadataCommand.js');
const products = read('routes/products.js');
const shopProducts = read('routes/shopProducts.js');
const requestCommand = read('services/supplementRequestCommand.js');
const state = read('utils/supplementState.js');
const requestModel = read('models/SupplementRequest.js');
const waveService = read('services/supplementWaveService.js');
const routing = read('services/receiptRoutingCorrectionCommand.js');
const supplementRoute = read('routes/supplement.js');
const offers = read('services/supplementOffers.js');

check('receipt metadata edits are not operational usage locks', () => {
  const critical = receipts.match(/const criticalEditFields = new Set\(\[([\s\S]*?)\]\);/);
  yes(critical, 'criticalEditFields missing');
  for (const field of ['price','qtyPerPackage','photoUrl','originalPhotoUrl','photoMeta','totalQty']) {
    no(critical[1].includes(`'${field}'`), `${field} must not require supplement cancellation`);
  }
  for (const field of ['destination','deliveryGroupIds','qtyPerShop']) yes(critical[1].includes(`'${field}'`), `${field} must remain guarded`);
});
check('current supplement snapshot propagates from ReceiptItem in transaction', () => {
  yes(sync.includes('syncCurrentSupplementSnapshots'), 'missing snapshot propagation');
  yes(sync.includes('status: { $in: ACTIVE_ITEM_STATUSES }'), 'OPEN/FROZEN fence missing');
  yes(sync.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE'), 'active item relation fence missing');
  yes(sync.includes('sourceSnapshot: sourceSnapshotFromReceiptItem(item)'), 'ReceiptItem must build current snapshot');
  yes(sync.includes('await syncCurrentSupplementSnapshots(item, { session })'), 'propagateItemEdit must invoke snapshot sync');
});
check('terminal revision snapshots are not selected for metadata propagation', () => {
  yes(sync.includes('ACTIVE_ITEM_STATUSES'), 'central active status vocabulary missing');
  no(/status:\s*\{\s*\$in:\s*\[[^\]]*(cancelled|completed)/i.test(sync), 'terminal statuses leaked into current snapshot update');
});
check('warehouse Product shared edits write through canonical receipt command', () => {
  yes(products.includes('syncReceiptItemCommercialMetadataFromProduct'), 'Product route missing command');
  yes(products.includes('receiptCommercialChanged'), 'Product route missing receipt-derived gate');
});
check('ShopProduct shared edits write through canonical receipt command', () => {
  yes(shopProducts.includes('syncReceiptItemCommercialMetadataFromProduct'), 'linked mirror path missing command');
  yes(shopProducts.includes('syncReceiptItemCommercialMetadataFromShopProduct'), 'shop-owned path missing command');
});
check('receipt-derived price correction has the same active-order side effect from every UI', () => {
  yes(sync.includes("require('../utils/repriceActiveOrders')"), 'receipt propagation must own repricing');
  yes(sync.includes('await repriceActiveOrders(product._id, Number(item.price), { session })'), 'transactional active-order repricing missing');
  yes(products.includes('&& !receiptCommercialChanged'), 'Product route must not double-reprice receipt-derived edits');
  yes(shopProducts.includes('&& !receiptCommercialChanged'), 'ShopProduct route must not double-reprice receipt-derived edits');
});
check('commercial command never owns routing or request cancellation', () => {
  no(command.includes('CorrectReceiptItemRouting'), 'commercial command must not route');
  no(command.includes('SupplementRequest'), 'commercial command must not mutate requests');
  no(command.includes('cancelOfferRevision'), 'commercial command must not cancel supplement');
  no(command.includes('cancelWave'), 'commercial command must not cancel container');
  yes(command.includes('propagateItemEdit'), 'commercial command must reuse canonical propagation');
});
check('quantityPerPackage stays metadata; no packed-unit accounting was invented', () => {
  const all = [command, sync, requestModel, requestCommand, waveService].join('\n');
  no(all.includes('packSizeAtPacking'), 'packSizeAtPacking is explicitly out of contract');
  no(all.includes('packedUnits'), 'packedUnits is explicitly out of contract');
});
check('seller and staff cancellations have distinct provenance', () => {
  yes(state.includes('REQUEST_CANCEL_SOURCE'), 'cancel source vocabulary missing');
  yes(requestModel.includes('cancelSource'), 'request cancelSource missing');
  yes(requestCommand.includes('request.cancelSource = REQUEST_CANCEL_SOURCE.SELLER'), 'seller cancellation provenance missing');
  yes(requestCommand.includes('request.cancelSource = REQUEST_CANCEL_SOURCE.STAFF'), 'staff cancellation provenance missing');
});
check('seller cannot resurrect staff-cancelled current request', () => {
  yes(requestCommand.includes('sellerMayRestoreRequest(existing)'), 'restore fence missing');
  yes(requestCommand.includes("throw appError('supplement_request_staff_cancelled')"), 'staff-cancel error missing');
  yes(state.includes("String(request.cancelReason || '') === 'seller_cancelled'"), 'legacy seller-cancel compatibility missing');
});
check('staff cancel upgrades an already seller-cancelled row to staff authority', () => {
  yes(requestCommand.includes('const wasCancelled = request.status === REQUEST_STATUS.CANCELLED'), 'cancelled-state authority upgrade missing');
  yes(requestCommand.includes("wasCancelled ? 'staff_cancel_enforced' : 'cancelled'"), 'staff enforcement audit action missing');
});
check('staff has an explicit OPEN-only restore command', () => {
  yes(requestCommand.includes('async function restoreRequestByStaff'), 'staff restore command missing');
  yes(requestCommand.includes('offer.status !== ITEM_STATUS.OPEN'), 'staff restore must be OPEN-only');
  yes(requestCommand.includes('request.cancelSource !== REQUEST_CANCEL_SOURCE.STAFF'), 'staff restore provenance fence missing');
  yes(supplementRoute.includes("'/requests/:requestId/restore'"), 'staff restore route missing');
});
check('seller read model exposes staff cancellation as locked', () => {
  yes(supplementRoute.includes('sellerBlocked'), 'sellerBlocked missing');
  yes(supplementRoute.includes("sellerBlockedReason: sellerBlocked ? 'staff_cancelled'"), 'staff cancellation reason missing');
});
check('routing only withdraws supplement when supplement disappears', () => {
  yes(routing.includes('livePrevious.supplement && !normalizedNext.supplement'), 'supplement disappearance fence missing');
  yes(routing.includes('withdrawReceiptItemFromActiveWaves'), 'withdraw command missing');
});
check('routing that retains supplement updates current artifact instead of cancelling', () => {
  yes(routing.includes('if (item.routing.supplement)'), 'supplement-retained branch missing');
  yes(routing.includes('sourceSnapshotFromReceiptItem(item)'), 'retained supplement snapshot update missing');
});
check('restore policy executes seller-only and fails closed for staff/system', () => {
  const policy = require('../utils/supplementState');
  yes(policy.sellerMayRestoreRequest({ status: policy.REQUEST_STATUS.CANCELLED, cancelSource: policy.REQUEST_CANCEL_SOURCE.SELLER }), 'seller cancel must restore');
  yes(policy.sellerMayRestoreRequest({ status: policy.REQUEST_STATUS.CANCELLED, cancelSource: '', cancelReason: 'seller_cancelled' }), 'legacy seller cancel must restore');
  no(policy.sellerMayRestoreRequest({ status: policy.REQUEST_STATUS.CANCELLED, cancelSource: policy.REQUEST_CANCEL_SOURCE.STAFF }), 'staff cancel must not restore');
  no(policy.sellerMayRestoreRequest({ status: policy.REQUEST_STATUS.CANCELLED, cancelSource: policy.REQUEST_CANCEL_SOURCE.SYSTEM }), 'system cancel must not restore');
  no(policy.sellerMayRestoreRequest({ status: policy.REQUEST_STATUS.CANCELLED, cancelSource: '', cancelReason: 'cancelled_by_staff' }), 'unknown administrative legacy cancel must fail closed');
});
check('seller product view documents current correction vs immutable terminal history', () => {
  yes(offers.includes('CURRENT OPEN/FROZEN revision'), 'current metadata correction contract comment missing');
  yes(offers.includes('terminal revisions remain immutable history'), 'terminal history contract missing');
});
console.log(`\nV48.S3.1 Supplement Metadata Authority: ${passed}/${passed+failed} PASS`);
if (failed) process.exit(1);
