'use strict';

const fs = require('fs');
const path = require('path');
const { describe, expect, it } = require('vitest');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');
const permissions = read('utils/receiptPermissions.js');

describe('receipt DELETE lifecycle 2026-09-12', () => {

  it('treats admin and warehouse equally for receipt-item deletion', () => {
    expect(permissions).toContain('function assertCanDeleteItem(user, item)');
    expect(permissions).toContain("if (!isReceiptStaff(user)) throw appError('forbidden')");
    const deletePermission = sliceBetweenOrThrow(
      permissions,
      'function assertCanDeleteItem',
      'function assertCanConfirmItem',
      { label: 'assertCanDeleteItem' },
    );
    expect(deletePermission).not.toContain("item.status === 'confirmed'");
    expect(deletePermission).not.toContain('isOwnerOrAdmin');
    expect(deletePermission).not.toContain("user.role === 'admin'");
  });
  it('allows only unrouted rows or archived warehouse products', () => {
    expect(sync).toContain('async function describeItemDeleteUsage');
    expect(sync).toContain("allowedState: usage.inUse ? null : 'unrouted'");
    expect(sync).toContain("product.status === 'archived'");
    expect(sync).toContain("allowedState: reasons.length ? null : 'archived'");
    expect(sync).toContain("reasons: ['товар уже має маршрут і переданий у роботу']");
    expect(sync.indexOf('if (archivedProduct)')).toBeLessThan(sync.indexOf('if (!hasRoute)'));
  });

  it('fails closed if an archived product still has active physical or operational work', () => {
    expect(sync).toContain("Block.findOne({ productIds: productId }, 'blockId')");
    expect(sync).toContain("status: { $in: ['new', 'in_progress'] }");
    expect(sync).toContain("status: { $in: ['pending', 'locked'] }");
    expect(sync).toContain('ACTIVE_ITEM_STATUSES');
    expect(sync).toContain('REQUEST_STATUS.ACTIVE');
  });

  it('preserves archived Product/history instead of deleting historical identities', () => {
    const handler = sliceBetweenOrThrow(
      receipts,
      "router.delete('/:id/items/:itemId'",
      "router.patch('/:id/items/:itemId/routing'",
      { label: 'receipt item DELETE' },
    );
    expect(handler).toContain('describeItemDeleteUsage(item, receipt, { session })');
    expect(handler).toContain('usage.preserveArchivedProduct');
    expect(handler).toContain('archivedProductPreserved: usage.productId');
    expect(handler).toContain('await item.deleteOne({ session })');
  });
});
