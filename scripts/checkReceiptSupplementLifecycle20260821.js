'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failed = 0;
function check(ok, message) {
  if (ok) console.log(`PASS: ${message}`);
  else { console.error(`FAIL: ${message}`); failed += 1; }
}

const routing = read('utils/receiptRouting.js');
const receipts = read('routes/receipts.js');
const correction = read('services/receiptRoutingCorrectionCommand.js');
const artifacts = read('services/receiptRoutingArtifacts.js');
const sync = read('services/receiptSync.js');
const wave = read('services/supplementWaveService.js');
const targets = read('services/supplementTargets.js');
const archive = read('services/archiveProductPrimitives.js');
const block = read('services/blockMoveCommand.js');
const product = read('models/Product.js');
const shopRoute = read('routes/shopProducts.js');
const productsRoute = read('routes/products.js');
const errors = read('utils/errors.js');
const index = read('index.js');

check(routing.includes('(r.mandatory || r.supplement) && !r.warehouse'),
  'mandatory-only and supplement-only own a standalone ShopProduct');
check(receipts.includes('needsStandaloneShopProduct(normalizeReceiptItemRouting(item, receipt))')
  && receipts.includes('upsertShopOwnedFromReceiptItem'),
  'confirm creates the standalone receipt-owned ShopProduct');
check(productsRoute.includes('linkedProductId: null') && productsRoute.includes("source: 'receive'"),
  'New Products projection includes standalone received ShopProducts');

check(correction.includes('RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN')
  && correction.includes("throw appError('receipt_supplement_route_open')")
  && errors.includes('receipt_supplement_route_open'),
  'OPEN supplement is a server routing hard lock');
check(correction.includes('RECEIPT_ITEM_SUPPLEMENT_STATE.COMPLETED')
  && correction.includes('Boolean(nextRouting.supplement) !== Boolean(previous.supplement)')
  && errors.includes('зняти або повторно увімкнути «Дозамовлення» через накладну не можна'),
  'COMPLETED supplement dimension is immutable through receipt routing');
check(receipts.includes('displaySupplementOffer') && receipts.includes('.filter(hasCompletedLifecycle)'),
  'completed supplement keeps its group context in receipt read model');
check(!/RECEIPT_ITEM_SUPPLEMENT_STATE\.FROZEN[\s\S]{0,120}throw appError\('receipt_supplement_route_open'/.test(correction),
  'FROZEN is not blocked by the OPEN routing guard');
check(correction.includes('livePrevious.supplement && !normalizedNext.supplement')
  && correction.includes('withdrawReceiptItemFromActiveWaves'),
  'removing supplement after seller input closes uses canonical cancellation');
check(wave.includes('status: REQUEST_STATUS.ACTIVE')
  && wave.includes('alreadyFulfilledShopIds: []')
  && !/withdrawReceiptItemFromActiveWaves[\s\S]{0,2400}packed:\s*false/.test(wave),
  'routing cancellation annuls all current requests, packed-marked rows included');
check(!/cancelOfferRevision[\s\S]{0,2600}packed:\s*false/.test(wave)
  && !/async function cancelWave[\s\S]{0,3200}packed:\s*false/.test(wave),
  'explicit item/wave cancellation also annuls the whole current revision');

check(targets.includes("state !== 'ordering_open'")
  && targets.includes("throw appError('supplement_ordering_still_open'"),
  'supplement cannot target a group while ordinary ordering is still open');

check(!correction.includes('archiveProductInSession')
  && !correction.includes('receipt_routing_correction')
  && correction.includes("mode: 'warehouse_detach'"),
  'routing correction never archives a Product');
check(sync.includes("mode === 'warehouse_detach' && product?.firstBlockPlacedAt")
  && sync.includes("Order.countDocuments({ 'items.productId': productId })")
  && sync.includes('PickingTask.countDocuments({ productId })'),
  'warehouse detach is blocked after shelf/order/picking facts');
check(artifacts.includes('convertReceiptWarehouseToShopOwned')
  && artifacts.includes('Product.deleteOne({ _id: productId })')
  && !artifacts.includes('SupplementOffer.delete'),
  'safe pre-process warehouse rollback changes only projection ownership, not supplement work');

check(block.includes('physicalLifecycleLockKey')
  && correction.includes(':physical-lifecycle')
  && read('services/archiveProduct.js').includes(':physical-lifecycle'),
  'shelf/archive/routing physical mutations share Product lifecycle serialization');
check(product.includes('{ receiptItemId: 1 }') && product.includes('partialFilterExpression'),
  'Product receipt identity has a unique partial database backstop');
check(artifacts.includes('Product.findOne({ receiptItemId: item._id })'),
  'lost createdProductId pointer resolves existing Product before create');
check(index.includes("key: 'receipt_product_identity'") && index.includes('models: [Product]'),
  'Product identity index is startup-critical and fails closed into maintenance');

check(archive.includes('reconcileSupplementForArchivedProduct')
  && archive.includes('REQUEST_CANCEL_SOURCE.SYSTEM')
  && archive.includes('cancelledSupplementRequestCount'),
  'physical Archive reconciles active supplement demand');
check(receipts.includes("status: 'archived'")
  && receipts.includes('товар уже в архіві — фізично видавати його більше не можна'),
  'archived Product cannot be republished as supplement');

check(shopRoute.includes("if (item.receiptItemId) throw appError('shopproduct_receipt_owned')"),
  'receipt-owned ShopProduct cannot be directly deleted');
check(receipts.includes('preflightReceiptItemRoutingCorrection')
  && receipts.includes("throw appError('receipt_routing_batch_blocked'"),
  'batch route change preflights all confirmed rows before writes');

if (failed) process.exit(1);
console.log('\nReceipt/Supplement lifecycle 2026-08-21: PASS');
