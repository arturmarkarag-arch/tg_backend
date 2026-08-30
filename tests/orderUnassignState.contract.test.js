const fs = require('fs');
const path = require('path');
const {
  ORDER_STATUS,
  ACTIVE_ORDER_STATUSES,
  isParkedOrderStatus,
  isOperationalOrderStatus,
  resolveOrderStatusAfterCancel,
} = require('../utils/orderStatus');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('seller-unassigned Order state contract', () => {
  it('preserves the existing order status recomputation API', () => {
    expect(typeof resolveOrderStatusAfterCancel).toBe('function');
  });

  it('keeps new_unassign outside current operational work', () => {
    expect(ORDER_STATUS.NEW_UNASSIGN).toBe('new_unassign');
    expect(ACTIVE_ORDER_STATUSES).not.toContain(ORDER_STATUS.NEW_UNASSIGN);
    expect(isParkedOrderStatus(ORDER_STATUS.NEW_UNASSIGN)).toBe(true);
    expect(isOperationalOrderStatus(ORDER_STATUS.NEW_UNASSIGN)).toBe(false);
  });

  it('parks by status rather than erasing shop/group/session ownership', () => {
    const src = read('services/unassignSeller.js');
    expect(src).toContain('ord.status = ORDER_STATUS.NEW_UNASSIGN');
    expect(src).not.toContain('ord.shopId = null');
    expect(src).not.toContain('ord.buyerSnapshot.shopId = null');
    expect(src).not.toContain("ord.buyerSnapshot.deliveryGroupId = ''");
  });

  it('restores an eligible parked order through the canonical ownership resolver', () => {
    const migrate = read('services/migrateSellerShop.js');
    const resolver = read('services/sellerOrderAssignment.js');
    expect(migrate).toContain('resolveSellerAssignmentOrder({');
    expect(resolver).toContain('PARKED_ORDER_STATUSES');
    expect(resolver).toContain('const canonicalParked = transferable.filter((row) => row.parked);');
    expect(migrate).toContain('if (restoredFromUnassign) activeOrder.status = ORDER_STATUS.NEW');
  });
});
