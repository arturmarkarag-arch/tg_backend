'use strict';

const {
  ASSIGNED_SHOP_ROLES,
  buildCurrentAssignment,
  isAssignedShopRole,
} = require('../utils/shopOperationalState');
const {
  buildReadinessShopProjection,
  buildCurrentSessionShopProjection,
} = require('../services/shopStatusProjection');

describe('V48.19 current shop assignment semantics', () => {
  const activeShop = {
    _id: 'shop-a',
    name: 'A',
    cityId: { name: 'City' },
    deliveryGroupId: 'group-a',
    isActive: true,
  };

  it('has one explicit assignable-role vocabulary', () => {
    expect(ASSIGNED_SHOP_ROLES).toEqual(['seller', 'admin']);
    expect(isAssignedShopRole('seller')).toBe(true);
    expect(isAssignedShopRole('admin')).toBe(true);
    expect(isAssignedShopRole('warehouse')).toBe(false);
  });

  it('separates assigned from operationally usable users', () => {
    const current = buildCurrentAssignment([
      { telegramId: '1', name: 'Seller', role: 'seller', accountState: 'active', botBlocked: false },
      { telegramId: '2', name: 'Blocked', role: 'seller', accountState: 'active', botBlocked: true },
      { telegramId: '3', name: 'Removed', role: 'admin', accountState: 'removed', botBlocked: false },
    ], { shop: activeShop });

    expect(current.assignedCount).toBe(3);
    expect(current.hasAssigned).toBe(true);
    expect(current.operationalCount).toBe(1);
    expect(current.hasOperationalUser).toBe(true);
    expect(current.assignedUsers.find((u) => u.telegramId === '2').operationalIssues).toContain('bot_blocked');
    expect(current.assignedUsers.find((u) => u.telegramId === '3').operationalIssues).toContain('account_removed');
  });

  it('an inactive shop has current assignment but no operational assignment', () => {
    const current = buildCurrentAssignment([
      { telegramId: '1', name: 'Seller', role: 'seller', accountState: 'active', botBlocked: false },
    ], { shop: { ...activeShop, isActive: false } });

    expect(current.hasAssigned).toBe(true);
    expect(current.assignedCount).toBe(1);
    expect(current.hasOperationalUser).toBe(false);
    expect(current.operationalCount).toBe(0);
    expect(current.shopOperationalIssues).toContain('shop_inactive');
  });

  it('readiness projection contains CURRENT assignment and no session/history roster', () => {
    const projection = buildReadinessShopProjection({
      shop: activeShop,
      assignedUsers: [{ telegramId: '1', name: 'Seller', role: 'seller', accountState: 'active' }],
    });

    expect(projection.currentAssignment.hasAssigned).toBe(true);
    expect(projection.sessionParticipants).toEqual([]);
    expect(projection.orders).toEqual([]);
    expect(projection.hasConflict).toBe(false);
    expect(projection.hasSellerOrderMismatch).toBe(false);
  });

  it('historical display can move away without changing CURRENT assignment truth', () => {
    const assignedUsers = [{ telegramId: '2', name: 'Now here', role: 'seller', accountState: 'active' }];
    const historicalDisplay = [{ telegramId: '1', name: 'Was here', role: 'seller', movedAway: true, hasOrder: true }];
    const projection = buildCurrentSessionShopProjection({
      shop: activeShop,
      assignedUsers,
      sessionParticipants: historicalDisplay,
      shopOrders: [{ buyerTelegramId: '1' }],
      orderedBuyerIds: new Set(['1']),
      orderedItemCount: 4,
    });

    expect(projection.currentAssignment.assignedUsers.map((u) => u.telegramId)).toEqual(['2']);
    expect(projection.sessionParticipants.map((u) => u.telegramId)).toEqual(['1']);
    expect(projection.sellerName).toBe('Was here'); // compatibility/display only
    expect(projection.currentAssignment.hasAssigned).toBe(true);
  });

  it('seller/order mismatch is derived from CURRENT assignment, never the display roster', () => {
    const projection = buildCurrentSessionShopProjection({
      shop: activeShop,
      assignedUsers: [
        { telegramId: '1', name: 'A', role: 'seller', accountState: 'active' },
        { telegramId: '2', name: 'B', role: 'seller', accountState: 'active' },
      ],
      sessionParticipants: [{ telegramId: 'legacy', name: 'Historical', role: 'seller' }],
      shopOrders: [{ buyerTelegramId: '1' }],
      orderedBuyerIds: new Set(['1']),
    });

    expect(projection.hasMultipleSellers).toBe(true);
    expect(projection.hasSellerOrderMismatch).toBe(true);
  });
});
