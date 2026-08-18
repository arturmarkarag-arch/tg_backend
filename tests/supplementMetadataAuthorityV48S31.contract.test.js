'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.S3.1 supplement metadata authority contracts', () => {
  it('does not treat ordinary metadata correction as supplement cancellation', () => {
    const route = read('routes/receipts.js');
    const critical = route.match(/const criticalEditFields = new Set\(\[([\s\S]*?)\]\);/)[1];
    for (const field of ['price','qtyPerPackage','photoUrl','originalPhotoUrl','photoMeta','totalQty']) {
      expect(critical).not.toContain(`'${field}'`);
    }
  });

  it('propagates ReceiptItem metadata only to current OPEN/FROZEN revisions', () => {
    const sync = read('services/receiptSync.js');
    expect(sync).toContain('syncCurrentSupplementSnapshots');
    expect(sync).toContain('status: { $in: ACTIVE_ITEM_STATUSES }');
    expect(sync).toContain('sourceSnapshot: sourceSnapshotFromReceiptItem(item)');
  });

  it('routes Product and ShopProduct shared metadata through ReceiptItem authority', () => {
    expect(read('routes/products.js')).toContain('syncReceiptItemCommercialMetadataFromProduct');
    const shops = read('routes/shopProducts.js');
    expect(shops).toContain('syncReceiptItemCommercialMetadataFromProduct');
    expect(shops).toContain('syncReceiptItemCommercialMetadataFromShopProduct');
  });

  it('keeps commercial metadata command independent of routing/request cancellation', () => {
    const command = read('services/receiptCommercialMetadataCommand.js');
    expect(command).toContain('propagateItemEdit');
    expect(command).not.toContain('SupplementRequest');
    expect(command).not.toContain('CorrectReceiptItemRouting');
    expect(command).not.toContain('cancelOfferRevision');
  });

  it('distinguishes seller cancellation from staff cancellation and fences restore', () => {
    const state = read('utils/supplementState.js');
    const command = read('services/supplementRequestCommand.js');
    expect(state).toContain('REQUEST_CANCEL_SOURCE');
    expect(state).toContain('sellerMayRestoreRequest');
    expect(command).toContain('REQUEST_CANCEL_SOURCE.SELLER');
    expect(command).toContain('REQUEST_CANCEL_SOURCE.STAFF');
    expect(command).toContain("throw appError('supplement_request_staff_cancelled')");
  });

  it('gives staff an explicit OPEN-only restore path for staff-cancelled demand', () => {
    const command = read('services/supplementRequestCommand.js');
    expect(command).toContain('restoreRequestByStaff');
    expect(command).toContain('offer.status !== ITEM_STATUS.OPEN');
    expect(command).toContain('REQUEST_CANCEL_SOURCE.STAFF');
    expect(read('routes/supplement.js')).toContain("'/requests/:requestId/restore'");
  });

  it('does not introduce unit-level packing state', () => {
    const source = [
      read('models/SupplementRequest.js'),
      read('services/supplementRequestCommand.js'),
      read('services/supplementWaveService.js'),
    ].join('\n');
    expect(source).not.toContain('packSizeAtPacking');
    expect(source).not.toContain('packedUnits');
  });

  it('withdraws supplement only when the corrected route loses supplement', () => {
    const correction = read('services/receiptRoutingCorrectionCommand.js');
    expect(correction).toContain('livePrevious.supplement && !normalizedNext.supplement');
    expect(correction).toContain('if (normalizedNext.supplement)');
  });
});
