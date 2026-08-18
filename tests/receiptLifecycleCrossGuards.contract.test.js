'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const { indexOrThrow, sliceIndexesOrThrow, sliceBetweenOrThrow } = require('./helpers/sourceContract');
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');

describe('V48.7 receipt cross-lifecycle guards', () => {
  it('preserves supplement publication history for destructive rollback while allowing metadata corrections', () => {
    expect(sync).toContain('item.supplementPublishRequestedAt && modernOffers.length === 0');
    expect(sync).toContain("SupplementOffer.find({ receiptItemId: item._id }, '_id waveId revision status itemStatus deliveryGroupId')");
    expect(sync).toContain("mode === 'destructive' && modernOffers.length > 0");
    expect(sync).toContain('statuses.has(ITEM_STATUS.FROZEN)');
    expect(sync).toContain('дозамовлення цієї позиції зараз відкрите для магазинів');
  });

  it('runs usage guard before DELETE/UNCONFIRM rollback even if back-references are damaged', () => {
    const deleteRoute = sliceBetweenOrThrow(receipts, "router.delete('/:id/items/:itemId'", "router.patch('/:id/items/:itemId/routing'", { label: 'receipt DELETE before routing' });
    expect(deleteRoute).toContain('const usage = await describeItemUsage(item, { session });');
    expect(indexOrThrow(deleteRoute, 'describeItemUsage')).toBeLessThan(indexOrThrow(deleteRoute, 'rollbackItemArtifacts'));

    const unconfirmRoute = sliceBetweenOrThrow(receipts, "router.post('/:id/items/:itemId/unconfirm'", "router.get('/:id/supplement-targets'", { label: 'receipt unconfirm route' });
    expect(unconfirmRoute).toContain('const usage = await describeItemUsage(item, { session });');
    expect(indexOrThrow(unconfirmRoute, 'describeItemUsage')).toBeLessThan(indexOrThrow(unconfirmRoute, 'rollbackItemArtifacts'));
  });

  it('locks commercial/identity edits once the confirmed item is already in a downstream process', () => {
    const patchRoute = sliceBetweenOrThrow(receipts, "router.patch('/:id/items/:itemId'", "router.delete('/:id/items/:itemId'", { label: 'receipt PATCH route' });
    for (const field of ['price', 'qtyPerPackage', 'originalPhotoUrl', 'destination', 'deliveryGroupIds', 'qtyPerShop']) {
      expect(patchRoute).toContain(`'${field}'`);
    }
    expect(patchRoute).toContain("item.status === 'confirmed'");
    expect(patchRoute).toContain('changedFields.some((field) => criticalEditFields.has(field))');
    expect(patchRoute).toContain('const usage = await describeItemUsage(item, { session: txSession });');
  });

  it('keeps cosmetic photo-label/comment corrections outside the critical edit lock', () => {
    const patchRoute = sliceBetweenOrThrow(receipts, "router.patch('/:id/items/:itemId'", "router.delete('/:id/items/:itemId'", { label: 'receipt PATCH route' });
    const criticalBlock = sliceBetweenOrThrow(patchRoute, 'const criticalEditFields = new Set([', ']);', { label: 'critical receipt edit fields' });
    expect(criticalBlock).not.toContain("'photoMeta'");
    expect(criticalBlock).not.toContain("'photoUrl'");
    expect(criticalBlock).not.toContain("'totalQty'");
  });

  it('keeps confirmed routing immutable except the additive warehouse-remainder endpoint', () => {
    const routingStart = indexOrThrow(receipts, "router.patch('/:id/items/:itemId/routing'");
    const remainderStart = indexOrThrow(receipts, "router.post('/:id/items/:itemId/add-warehouse-remainder'", { from: routingStart });
    const routingRoute = sliceIndexesOrThrow(receipts, routingStart, remainderStart, { label: 'receipt routing route' });
    expect(routingRoute).toContain("status: 'draft'");
    expect(routingRoute).toContain("throw appError('receipt_route_locked')");

    const confirmStart = indexOrThrow(receipts, "router.post('/:id/items/:itemId/confirm'", { from: remainderStart });
    const remainderRoute = sliceIndexesOrThrow(receipts, remainderStart, confirmStart, { label: 'warehouse remainder route' });
    expect(remainderRoute).toContain('if (before.warehouse)');
    expect(remainderRoute).toContain('warehouse: true');
    expect(remainderRoute).toContain('...before');
    expect(remainderRoute).not.toContain('rollbackItemArtifacts');
  });

  it('batch publish cannot steal an item that was concurrently unconfirmed/deleted or reassign an already claimed item', () => {
    const publishRoute = sliceBetweenOrThrow(receipts, "router.post('/supplement-batches/:deliveryGroupId/publish'", "router.get('/:id'", { label: 'supplement batch publish route' });

    const candidatesStart = indexOrThrow(publishRoute, 'const candidates = await ReceiptItem.find(');
    const existingStart = indexOrThrow(publishRoute, 'const existingPublications = await SupplementOffer.find', { from: candidatesStart });
    const candidates = sliceIndexesOrThrow(publishRoute, candidatesStart, existingStart, { label: 'supplement candidate fence' });
    expect(candidates).toContain("status: 'confirmed'");
    expect(candidates).toContain("'routing.supplement': true");
    expect(candidates).toContain('routingVersion: { $gte: 1 }');
    expect(candidates).toContain('supplementBatchVersion: { $gte: 1 }');
    expect(candidates).not.toContain('createdProductId: { $ne: null }');

    const selectedStart = indexOrThrow(publishRoute, 'const selectedRows = publishable.filter', { from: existingStart });
    const selectedEnd = indexOrThrow(publishRoute, 'if (!selectedRows.length)', { from: selectedStart });
    const selected = sliceIndexesOrThrow(publishRoute, existingStart, selectedEnd, { label: 'item-global publication fence' });
    expect(selected).toContain('waveId: { $ne: null }');
    expect(selected).toContain('blockedItemIds');
    expect(selected).toContain('existingPublications.filter(blocksGenericRepublish)');
  });
});
