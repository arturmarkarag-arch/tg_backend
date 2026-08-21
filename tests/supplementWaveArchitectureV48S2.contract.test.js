'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.S2 supplement guarantees preserved by V48.S3', () => {
  it('still pins supplement work to one exact current delivery session', () => {
    const model = read('models/SupplementWave.js');
    const targets = read('services/supplementTargets.js');
    const receipts = read('routes/receipts.js');
    expect(model).toContain('orderingSessionId');
    expect(model).toContain('deliveryGroupId');
    expect(model).toContain('containerKey');
    expect(targets).toContain('findCurrentSessionId');
    expect(targets).toContain('expectedOrderingSessionId');
    expect(receipts).toContain('withSessionLifecycleLock(firstTarget.orderingSessionId');
  });

  it('keeps item-global publication history instead of a one-shot ReceiptItem flag', () => {
    const receipts = read('routes/receipts.js');
    expect(receipts).toContain('existingPublications');
    expect(receipts).toContain('blockedItemIds');
    expect(receipts).toContain('readyCount: readyCountForTarget');
    expect(receipts).toContain('lifecycle is item-global, not target-local');
    expect(receipts).toContain('blocksGenericRepublish');
  });

  it('keeps only current active item revision aligned when routing switches warehouse on/off', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    expect(command).toContain('SupplementOffer.updateMany');
    expect(command).toContain('status: { $in: ACTIVE_ITEM_STATUSES }');
    expect(command).toContain('itemStatus: ITEM_RELATION_STATUS.ACTIVE');
    expect(command).toContain('productId: item.createdProductId || null');
    expect(command).toContain('sourceSnapshotFromReceiptItem(item)');
  });

  it('keeps the old destructive session-field migration retired', () => {
    const tombstone = read('scripts/dropSupplementSessionField.js');
    expect(tombstone).toContain('retired by V48.S2');
    expect(tombstone).not.toContain('mongoose.connect');
  });

  it('preserves OPEN seller editing and FROZEN packing as item-level states', () => {
    const route = read('routes/supplement.js');
    const state = read('utils/supplementState.js');
    const wave = read('services/supplementWaveService.js');
    expect(route).toContain('effective !== ITEM_STATUS.FROZEN');
    expect(route).toContain('supplement_pack_before_freeze');
    expect(state).toContain('function isSellerEditable');
    expect(state).toContain('function isPackable');
    expect(wave).toContain('status: ITEM_STATUS.OPEN');
    expect(wave).toContain('status: ITEM_STATUS.FROZEN');
  });

  it('allows supplement-only rows without a fake warehouse Product', () => {
    const model = read('models/SupplementOffer.js');
    const artifacts = read('services/receiptRoutingArtifacts.js');
    expect(model).toMatch(/productId:[\s\S]*default: null/);
    expect(artifacts).toContain('if (!needsWarehouseProduct(routing)) return null');
  });

  it('still makes exact-session supplement work a delivery-session completion blocker', () => {
    const status = read('utils/sessionStatus.js');
    const closure = read('services/sessionClosure.js');
    expect(status).toContain('SupplementOffer.countDocuments');
    expect(status).toContain('orderingSessionId: String(orderingSessionId)');
    expect(closure).toContain('SupplementOffer.find');
    expect(closure).toContain('active_supplement_waves');
  });

  it('annuls the whole current supplement revision after seller input is frozen', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    const wave = read('services/supplementWaveService.js');
    expect(command).toContain('withdrawReceiptItemFromActiveWaves');
    expect(command).toContain('RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN');
    expect(wave).toContain('status: REQUEST_STATUS.ACTIVE');
    expect(wave).not.toContain('const packed = requests.filter((r) => r.packed)');
    expect(wave).toContain('alreadyFulfilledShopIds: []');
  });

  it('keeps modern lifecycle notifications container-scoped while legacy offer notifications stay isolated', () => {
    const notify = read('services/supplementNotify.js');
    const wave = read('models/SupplementWave.js');
    expect(notify).toContain('notifyWaves');
    expect(notify).toContain('SupplementWave');
    expect(wave).toContain('activityRevision');
    expect((notify.match(/waveId: null/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('never archives or detaches a physical Product as a routing side effect', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    const archive = read('services/archiveProduct.js');
    const primitive = read('services/archiveProductPrimitives.js');
    expect(command).not.toContain('archiveProductInSession');
    expect(command).not.toContain('receipt_routing_correction');
    expect(command).toContain("mode: 'warehouse_detach'");
    expect(archive).toContain('archiveProductInSession');
    expect(primitive).toContain('detachProductFromAllBlocks');
  });

  it('treats supplement container/item/request indexes as startup-critical', () => {
    const index = read('index.js');
    expect(index).toContain("key: 'supplements'");
    expect(index).toContain("require('./models/SupplementWave')");
    expect(index).toContain('SupplementWave.containerKey');
    expect(index).toContain('SupplementRequest = offerId+revision+shopId');
  });

  it('projects supplement work into existing shift history without mixing units or revisions', () => {
    const picking = read('routes/picking.js');
    const projection = read('services/readModels/supplementShiftActivityReadModel.js');
    expect(picking).toContain('totalSupplementPacked');
    expect(picking).toContain('supplementPackedCount');
    expect(picking).toContain('getSupplementWorkerHistory');
    expect(projection).toContain("kind: 'supplement'");
    expect(projection).toContain('offerSnapshotForRequestRevision');
  });

  it('enforces same-session supplement exclusion at catalogue and order write boundary', () => {
    const products = read('routes/products.js');
    const orders = read('routes/orders.js');
    const exclusion = read('services/supplementSessionExclusion.js');
    expect(products).toContain('getSupplementExcludedProductIds');
    expect(orders).toContain('assertProductOrdinaryOrderable');
    expect(exclusion).toContain('itemStatus: ITEM_RELATION_STATUS.ACTIVE');
    expect(exclusion).toContain('ITEM_STATUS.COMPLETED');
    expect(exclusion).toContain('ITEM_STATUS.CANCELLED');
    expect(exclusion).toContain("waveId: { $ne: null }");
  });

  it('keeps modern container/item transitions transactional and legacy compatibility isolated', () => {
    const wave = read('services/supplementWaveService.js');
    const offers = read('services/supplementOffers.js');
    expect((wave.match(/withTransaction/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(wave).toContain('ensureContainer');
    expect(wave).toContain('recomputeWaveSummaryInSession');
    expect(offers).toContain("waveId: null");
  });

  it('keeps future/shop-less targets closed while allowing only exact-current cancellation recovery', () => {
    const targets = read('services/supplementTargets.js');
    expect(targets).toContain("state !== 'completed'");
    expect(targets).toContain("state !== 'upcoming_not_started'");
    expect(targets).toContain('hasReopenableSupplementCancellation');
    expect(targets).toContain('status: ITEM_STATUS.CANCELLED');
    expect(targets).toContain('shopCount > 0');
    expect(targets).toContain('Shop.exists({ deliveryGroupId: gid, isActive: true })');
  });
});
