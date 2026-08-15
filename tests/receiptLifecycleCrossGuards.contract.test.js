'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');

describe('V48.7 receipt cross-lifecycle guards', () => {
  it('treats supplement publication itself as irreversible usage', () => {
    expect(sync).toContain('if (item.supplementPublishRequestedAt)');
    expect(sync).toContain("SupplementOffer.find({ receiptItemId: item._id }, '_id status deliveryGroupId')");
    expect(sync).toContain("statuses.has('completed')");
    expect(sync).toContain("statuses.has('frozen')");
    expect(sync).toContain('дозамовлення вже відкрито для магазинів');
  });

  it('runs usage guard before DELETE/UNCONFIRM rollback even if back-references are damaged', () => {
    const deleteStart = receipts.indexOf("router.delete('/:id/items/:itemId'");
    const routingStart = receipts.indexOf("router.patch('/:id/items/:itemId/routing'", deleteStart);
    const deleteRoute = receipts.slice(deleteStart, routingStart);
    expect(deleteRoute).toContain('const usage = await describeItemUsage(item, { session });');
    expect(deleteRoute.indexOf('describeItemUsage')).toBeLessThan(deleteRoute.indexOf('rollbackItemArtifacts'));

    const unconfirmStart = receipts.indexOf("router.post('/:id/items/:itemId/unconfirm'");
    const targetsStart = receipts.indexOf("router.get('/:id/supplement-targets'", unconfirmStart);
    const unconfirmRoute = receipts.slice(unconfirmStart, targetsStart);
    expect(unconfirmRoute).toContain('const usage = await describeItemUsage(item, { session });');
    expect(unconfirmRoute.indexOf('describeItemUsage')).toBeLessThan(unconfirmRoute.indexOf('rollbackItemArtifacts'));
  });

  it('locks commercial/identity edits once the confirmed item is already in a downstream process', () => {
    const patchStart = receipts.indexOf("router.patch('/:id/items/:itemId'");
    const deleteStart = receipts.indexOf("router.delete('/:id/items/:itemId'", patchStart);
    const patchRoute = receipts.slice(patchStart, deleteStart);
    for (const field of ['price', 'qtyPerPackage', 'originalPhotoUrl', 'destination', 'deliveryGroupIds', 'qtyPerShop']) {
      expect(patchRoute).toContain(`'${field}'`);
    }
    expect(patchRoute).toContain("item.status === 'confirmed'");
    expect(patchRoute).toContain('changedFields.some((field) => criticalEditFields.has(field))');
    expect(patchRoute).toContain('const usage = await describeItemUsage(item, { session: txSession });');
  });

  it('keeps cosmetic photo-label/comment corrections outside the critical edit lock', () => {
    const patchStart = receipts.indexOf("router.patch('/:id/items/:itemId'");
    const deleteStart = receipts.indexOf("router.delete('/:id/items/:itemId'", patchStart);
    const patchRoute = receipts.slice(patchStart, deleteStart);
    const criticalStart = patchRoute.indexOf('const criticalEditFields = new Set([');
    const criticalEnd = patchRoute.indexOf(']);', criticalStart);
    const criticalBlock = patchRoute.slice(criticalStart, criticalEnd);
    expect(criticalBlock).not.toContain("'photoMeta'");
    expect(criticalBlock).not.toContain("'photoUrl'");
    expect(criticalBlock).not.toContain("'totalQty'");
  });

  it('keeps confirmed routing immutable except the additive warehouse-remainder endpoint', () => {
    const routingStart = receipts.indexOf("router.patch('/:id/items/:itemId/routing'");
    const remainderStart = receipts.indexOf("router.post('/:id/items/:itemId/add-warehouse-remainder'", routingStart);
    const routingRoute = receipts.slice(routingStart, remainderStart);
    expect(routingRoute).toContain("status: 'draft'");
    expect(routingRoute).toContain("throw appError('receipt_route_locked')");

    const confirmStart = receipts.indexOf("router.post('/:id/items/:itemId/confirm'", remainderStart);
    const remainderRoute = receipts.slice(remainderStart, confirmStart);
    expect(remainderRoute).toContain('if (before.warehouse)');
    expect(remainderRoute).toContain('warehouse: true');
    expect(remainderRoute).toContain('...before');
    expect(remainderRoute).not.toContain('rollbackItemArtifacts');
  });

  it('batch publish cannot steal an item that was concurrently unconfirmed/deleted or reassign an already claimed item', () => {
    const publishStart = receipts.indexOf("router.post('/supplement-batches/:deliveryGroupId/publish'");
    const detailStart = receipts.indexOf("router.get('/:id'", publishStart);
    const publishRoute = receipts.slice(publishStart, detailStart);

    const updateStart = publishRoute.indexOf('await ReceiptItem.updateMany(');
    const selectedStart = publishRoute.indexOf('const selectedRows = await ReceiptItem.find(', updateStart);
    const claim = publishRoute.slice(updateStart, selectedStart);
    expect(claim).toContain("status: 'confirmed'");
    expect(claim).toContain("'routing.supplement': true");
    expect(claim).toContain('createdProductId: { $ne: null }');
    expect(claim).toContain('supplementPublishRequestedAt: null');

    const selectedEnd = publishRoute.indexOf('if (!selectedRows.length)', selectedStart);
    const selected = publishRoute.slice(selectedStart, selectedEnd);
    expect(selected).toContain("status: 'confirmed'");
    expect(selected).toContain('createdProductId: { $ne: null }');
    expect(selected).toContain("'routing.supplementDeliveryGroupId': deliveryGroupId");
    expect(selected).toContain('supplementPublishRequestedAt: now');
  });
});
