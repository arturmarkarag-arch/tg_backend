const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('multi-seller + shop-owned order contract', () => {
  const orderModel = read('models/Order.js');
  const migrate = read('services/migrateSellerShop.js');
  const unassign = read('services/unassignSeller.js');
  const conflict = read('utils/shopConflict.js');
  const conflictRoute = read('routes/orders.js');
  const shopTransfer = read('routes/shopTransfer.js');
  const docs = read('docs/architecture/operational-session-contract.md');
  const audit = read('scripts/auditOperationalContracts.js');

  test('multiple sellers are legal and seller presence alone is not a conflict', () => {
    expect(docs).toContain('Multiple sellers MAY be assigned to one shop');
    expect(conflict).toContain('const hasConflict = distinctBuyers.size > 1;');
    expect(shopTransfer).toContain('approval must never evict an existing seller');
    expect(shopTransfer).not.toContain('displacedPatch');
    expect(audit).toContain('Shop -> multiple sellers allowed');
  });

  test('DB uniqueness stays buyer + shop + ordering session, not shop + session', () => {
    expect(orderModel).toContain("{ buyerTelegramId: 1, shopId: 1, orderingSessionId: 1 }");
    expect(orderModel).toContain("name: 'one_active_order_per_buyer_shop_session'");
    expect(docs).toContain('Do NOT replace it');
  });

  test('ordinary seller moves cannot rewrite a frozen shop-owned order', () => {
    expect(migrate).toContain('allowFrozenOrderTransfer = false');
    expect(migrate).toContain('shopOwnedOrder = resolution.stayedOrder');
    expect(unassign).toContain('allowFrozenOrderPark = false');
    expect(unassign).toContain('for (const row of resolution.rows)');
    expect(unassign).toContain('if (!row.frozen');
    expect(docs).toContain('The seller remains the historical');
  });

  test('dedicated conflict repair is an explicit audited ownership override', () => {
    expect(conflictRoute).toContain('allowFrozenOrderTransfer: true');
    expect(conflictRoute).toContain('allowFrozenOrderPark: true');
    expect(migrate).toContain('ownershipRepair: Boolean(ownership.frozen && allowFrozenOrderTransfer)');
    expect(unassign).toContain('ownershipRepair: Boolean(ownership.frozen && allowFrozenOrderPark)');
  });
});
