'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.S2 supplement Wave architecture contracts', () => {
  it('pins every new Wave to one exact current delivery session', () => {
    const model = read('models/SupplementWave.js');
    const targets = read('services/supplementTargets.js');
    const receipts = read('routes/receipts.js');
    expect(model).toContain('orderingSessionId');
    expect(model).toContain('deliveryGroupId');
    expect(targets).toContain('findCurrentSessionId');
    expect(targets).toContain('expectedOrderingSessionId');
    expect(receipts).toContain('withSessionLifecycleLock(firstTarget.orderingSessionId');
  });


  it('uses exact-session child existence instead of a one-shot ReceiptItem publication flag', () => {
    const receipts = read('routes/receipts.js');
    expect(receipts).toContain('existingTargetItems');
    expect(receipts).toContain('readyCount: readyCountForTarget');
    expect(receipts).toContain('published at least once');
  });

  it('keeps an active Wave child aligned when routing switches warehouse on/off', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    expect(command).toContain('SupplementOffer.updateMany');
    expect(command).toContain('productId: item.createdProductId || null');
    expect(command).toContain('sourceSnapshotFromReceiptItem(item)');
  });

  it('retires the old destructive session-field migration', () => {
    const tombstone = read('scripts/dropSupplementSessionField.js');
    expect(tombstone).toContain('retired by V48.S2');
    expect(tombstone).not.toContain('mongoose.connect');
  });

  it('keeps OPEN seller editing separate from FROZEN packing', () => {
    const route = read('routes/supplement.js');
    const wave = read('services/supplementWaveService.js');
    expect(route).toContain("effective !== 'open'");
    expect(route).toContain("effective !== 'frozen'");
    expect(route).toContain('supplement_pack_before_freeze');
    expect(wave).toContain("wave.status !== 'frozen'");
  });

  it('allows supplement-only rows without a fake warehouse Product', () => {
    const model = read('models/SupplementOffer.js');
    const artifacts = read('services/receiptRoutingArtifacts.js');
    expect(model).toMatch(/productId:[\s\S]*default: null/);
    expect(artifacts).toContain('if (!needsWarehouseProduct(routing)) return null');
  });

  it('makes supplement a delivery-session completion blocker', () => {
    const status = read('utils/sessionStatus.js');
    const closure = read('services/sessionClosure.js');
    expect(status).toContain('SupplementWave.countDocuments');
    expect(status).toContain('orderingSessionId: String(orderingSessionId)');
    expect(closure).toContain('active_supplement_waves');
  });

  it('uses compensating routing correction and preserves packed facts', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    const wave = read('services/supplementWaveService.js');
    expect(command).toContain('withdrawReceiptItemFromActiveWaves');
    expect(command).toContain('alreadyFulfilledShopIds');
    expect(wave).toContain('const packed = requests.filter((r) => r.packed)');
    expect(wave).toContain('const unpacked = requests.filter((r) => !r.packed)');
  });

  it('keeps Wave lifecycle Telegram idempotency off child items', () => {
    const notify = read('services/supplementNotify.js');
    expect(notify).toContain('notifyWaves');
    expect(notify).toContain('SupplementWave');
    expect((notify.match(/waveId: null/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('composes obsolete Product archive inside the route-correction transaction', () => {
    const command = read('services/receiptRoutingCorrectionCommand.js');
    const archive = read('services/archiveProduct.js');
    const primitive = read('services/archiveProductPrimitives.js');
    expect(command).toContain('archiveProductInSession');
    expect(command).not.toContain('await archiveProduct(');
    expect(archive).toContain('archiveProductInSession');
    expect(primitive).toContain('detachProductFromAllBlocks');
  });

  it('treats SupplementWave indexes as startup-critical', () => {
    const index = read('index.js');
    expect(index).toContain("require('./models/SupplementWave')");
    expect(index).toContain('SupplementWave.publicationKey');
  });

  it('projects supplement work into existing shift history without mixing units', () => {
    const picking = read('routes/picking.js');
    const projection = read('services/readModels/supplementShiftActivityReadModel.js');
    expect(picking).toContain('totalSupplementPacked');
    expect(picking).toContain('supplementPackedCount');
    expect(picking).toContain('getSupplementWorkerHistory');
    expect(projection).toContain("kind: 'supplement'");
  });

  it('enforces same-session supplement exclusion at both catalogue and order write boundary', () => {
    const products = read('routes/products.js');
    const orders = read('routes/orders.js');
    const exclusion = read('services/supplementSessionExclusion.js');
    expect(products).toContain('getSupplementExcludedProductIds');
    expect(orders).toContain('assertProductOrdinaryOrderable');
    expect(exclusion).toContain("itemStatus: 'active'");
    expect(exclusion).toContain("waveId: { $ne: null }");
  });

  it('makes Wave lifecycle root + compatibility children transition atomically', () => {
    const wave = read('services/supplementWaveService.js');
    expect((wave.match(/withTransaction/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(wave).toContain('await existing.save({ session: mongoSession })');
    expect(wave).toContain('await wave.save({ session: mongoSession })');
  });

  it('does not present future or shop-less groups as selectable targets', () => {
    const targets = read('services/supplementTargets.js');
    expect(targets).toContain("!['completed', 'upcoming_not_started'].includes(state)");
    expect(targets).toContain('shopCount > 0');
    expect(targets).toContain('Shop.exists({ deliveryGroupId: gid, isActive: true })');
  });

});
