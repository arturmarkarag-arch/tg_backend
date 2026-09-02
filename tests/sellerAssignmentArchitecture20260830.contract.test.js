'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('seller assignment ownership architecture 2026-08-30', () => {
  it('discovers source Order by seller ownership rather than CURRENT/NEXT session bucket', () => {
    const resolver = read('services/sellerOrderAssignment.js');
    const migration = read('services/migrateSellerShop.js');

    expect(resolver).toContain('buyerTelegramId: tid');
    expect(resolver).toContain('status: { $in: ASSIGNMENT_RELEVANT_STATUSES }');
    expect(resolver).toContain('getOrderOwnershipState(order, { session, now })');
    expect(resolver).not.toMatch(/findCurrentSessionId|getOrCreateNextSessionId|getOrCreateSessionId/);

    expect(migration).toContain('resolveSellerAssignmentOrder({');
    expect(migration).not.toContain("require('../utils/orderShopFilter')");
    expect(migration).not.toContain('activeOrderShopFilter(');
  });

  it('keeps destination CURRENT/NEXT routing separate from source ownership', () => {
    const routing = read('services/orderAssignmentRouting.js');
    const migration = read('services/migrateSellerShop.js');

    expect(routing).toContain("currentSession.pickingStatus === 'pending'");
    expect(routing).toContain('isOrderingOpen(group.orderingSchedule, now).isOpen');
    expect(routing).toContain("routeReason: orderingOpen ? 'current_picking_started' : 'current_ordering_closed'");
    expect(routing).toContain('getOrCreateNextSessionId(');
    expect(routing).not.toMatch(/currentSession\.closeAt/);
    expect(migration).toContain('resolveAssignmentDestination({');
    expect(migration).toContain('now: ownershipNow');
  });

  it('fails closed for duplicate/mismatched mutable ownership and validates post-write state', () => {
    const resolver = read('services/sellerOrderAssignment.js');
    expect(resolver).toContain("invariantError('multiple_transferable_orders'");
    expect(resolver).toContain("invariantError('transferable_order_shop_mismatch'");
    expect(resolver).toContain("invariantError('order_shop_snapshot_mismatch'");
    expect(resolver).toContain("invariantError('transferable_order_session_group_mismatch'");
    expect(resolver).toContain('async function assertSellerAssignmentOrderInvariant');
  });

  it('treats frozen historical Orders as visibility-only for ordinary assignment', () => {
    const resolver = read('services/sellerOrderAssignment.js');
    const ownership = read('utils/orderOwnership.js');

    expect(resolver).toContain('const transferable = rows.filter((row) => !row.frozen)');
    expect(resolver).toContain('Frozen historical rows are ignored for transfer');
    expect(ownership).toContain("reason: 'picking_pipeline'");
    expect(ownership).toContain("reason: 'session_not_found'");
    expect(ownership).toContain("reason: 'picking_started'");
    expect(ownership).toContain("'ordering_closed'");
  });

  it('uses the same ownership resolver for unassign/park and preserves explicit parked state', () => {
    const unassign = read('services/unassignSeller.js');
    const status = read('utils/orderStatus.js');
    expect(unassign).toContain('resolveSellerAssignmentOrder({');
    expect(unassign).toContain('ord.status = ORDER_STATUS.NEW_UNASSIGN');
    expect(unassign).toContain('assertSellerAssignmentOrderInvariant({');
    expect(status).toContain("NEW_UNASSIGN: 'new_unassign'");
  });

  it('fences seller Order writers against a concurrently changed CURRENT assignment', () => {
    const orders = read('routes/orders.js');
    expect(orders).toContain('async function updateSellerStateForExpectedAssignment');
    expect(orders).toContain("throw appError('seller_assignment_changed')");
    expect((orders.match(/updateSellerStateForExpectedAssignment\(\{/g) || []).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps explicit Order repair and stale restore on the same destination/invariant contract', () => {
    const orders = read('routes/orders.js');
    expect(orders).toContain("router.patch('/:id/snapshot'");
    expect(orders).toContain("A stale Order's snapshot is HISTORY");
    expect(orders).toContain('resolveAssignmentDestination({');
    expect(orders).toContain('assertSellerAssignmentOrderInvariant({');
    expect(orders).toMatch(/activeOrderShopFilter\(targetShop\._id,[\s\S]{0,500}orderingSessionId:\s*newSessionId/);
  });

  it('keeps frontend transport-only for seller move routing', () => {
    const api = read('../client/src/api.js');
    const modal = read('../client/src/components/picking/SellerReassignModal.jsx');
    expect(api).toContain("request(`/users/${telegramId}/shop`");
    expect(modal).toContain('assignUserToShop(');
    expect(api).not.toContain('routedToNextSession');
    expect(modal).not.toContain('routedToNextSession');
  });
});
