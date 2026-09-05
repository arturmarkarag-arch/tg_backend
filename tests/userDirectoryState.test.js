'use strict';

const User = require('../models/User');
const { normalizeCartState, normalizeMiniAppState } = require('../utils/catalogNavigationState');
const { toShopTransferDto } = require('../utils/shopTransferDto');
const { snapshotGuard, USER_FIELDS } = require('../scripts/cleanupUserDirectoryLegacyFields');

describe('directory state retirement', () => {
  it('retains the catalogue session fence and cursor while omitting arbitrary old state', () => {
    const state = normalizeCartState({
      navigationSessionId: 'session-current', lastViewedProductId: 'product-current', currentIndex: 1278,
      updatedAt: '2026-09-05T01:00:00Z', currentPage: 127, lastViewedOrderNumber: 1522,
      orderItems: { legacy: 6 }, orderItemIds: ['legacy'], lastOrderPositions: 100,
      privateFutureField: 'do not serialize',
    });
    expect(state).toEqual({ navigationSessionId: 'session-current', lastViewedProductId: 'product-current', currentIndex: 1278, updatedAt: '2026-09-05T01:00:00Z' });
    expect(normalizeMiniAppState({ currentIndex: 999, viewMode: 'carousel', updatedAt: 'activity' })).toEqual({ updatedAt: 'activity' });
  });

  it('does not create dead fields on new User documents', () => {
    const user = new User({ telegramId: 'isolated' }).toObject();
    for (const field of ['isOnline', 'lastActive', 'permissions']) expect(user).not.toHaveProperty(field);
    expect(Object.keys(user.cartState).sort()).toEqual(['currentIndex', 'lastViewedProductId', 'navigationSessionId', 'updatedAt'].sort());
    expect(normalizeCartState({ currentIndex: -10 }).currentIndex).toBe(0);
  });

  it('does not expose displacement/cart legacy fields from lean transfer documents', () => {
    const dto = toShopTransferDto({
      _id: 'transfer', status: 'approved', displacedSellerTelegramId: 'old-person', cartDecision: 'clear', unknown: 'private',
      conflictSnapshot: { targetShopSellerCount: 2, cartHasItems: true, unknown: 'private' },
      profileUpdate: { firstName: 'Name', unknown: 'private' },
    });
    expect(dto).toEqual({ _id: 'transfer', status: 'approved', conflictSnapshot: { targetShopSellerCount: 2 }, profileUpdate: { firstName: 'Name' } });
  });

  it('guards both present and absent retired fields before cleanup, preserving live navigation', () => {
    const document = { _id: 'user', cartState: { orderItems: { p: 2 }, currentPage: 3, navigationSessionId: 'keep' } };
    const guard = snapshotGuard(document, USER_FIELDS);
    expect(guard['cartState.orderItems']).toEqual({ $eq: { p: 2 } });
    expect(guard['cartState.orderItemIds']).toEqual({ $exists: false });
    expect(USER_FIELDS).not.toContain('cartState.navigationSessionId');
    expect(USER_FIELDS).not.toContain('cartState.lastViewedProductId');
    expect(USER_FIELDS).not.toContain('cartState.currentIndex');
    expect(USER_FIELDS).not.toContain('cartState.updatedAt');
    expect(USER_FIELDS).not.toContain('history');
  });
});
