'use strict';
/**
 * Regression guard for the shop-link redeem ORDER OF OPERATIONS.
 *
 * `return` inside session.withTransaction() COMMITS the transaction — it does not
 * abort it. So every refusal path (shop_inactive / not_seller / same_shop) must be
 * evaluated BEFORE the token is consumed; consuming first burnt the link on a
 * redeem that never happened and the bot answered "магазин неактивний" over an
 * already-dead code.
 *
 * No database, no Redis: the module's dependencies are stubbed straight in
 * require.cache. vi.mock() is useless here — these are CommonJS files loaded with
 * a real require(), which vitest's module mocker does not intercept.
 */
const path = require('path');

// ── Dependency stubs ─────────────────────────────────────────────────────────
const state = {
  shopReads: [],   // queue: one entry per Shop.findById() — [pre-check, in-tx]
  sellerReads: [], // queue: one entry per User.findOne()
  tokenUsed: false,
  committed: false,
  migrateCalled: false,
  published: null,
};

const nextShop   = () => (state.shopReads.length > 1 ? state.shopReads.shift() : state.shopReads[0]);
const nextSeller = () => (state.sellerReads.length > 1 ? state.sellerReads.shift() : state.sellerReads[0]);

function stub(request, exports) {
  const full = require.resolve(request.startsWith('.') ? path.join(__dirname, '..', request.slice(2)) : request);
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}

stub('./models/Shop', {
  findById: () => ({
    populate: () => ({ session: () => ({ lean: async () => nextShop() }) }),
    lean: async () => nextShop(),
  }),
});

stub('./models/User', {
  findOne: () => ({
    session: () => ({ lean: async () => nextSeller() }),
    lean: async () => nextSeller(),
  }),
});

stub('./utils/lock', { withLock: (_key, fn) => fn() });
stub('./utils/modelCache', { invalidateShop: async () => {} });

stub('./services/shopAssignmentCommand', {
  publishShopAssignmentTransition: async (transition) => {
    state.published = transition;
  },
});

stub('./services/migrateSellerShop', {
  migrateSellerShop: async () => {
    state.migrateCalled = true;
    return { movedOrder: false, prevGroupId: null, newGroupId: 'g2', invalidate: null };
  },
});

stub('./services/registrationToken', {
  normalizeShopCode: (raw) => String(raw || '').trim().toUpperCase(),
  peekShopInvite: async () => (state.tokenUsed ? null : { token: 'ZP-AAAAAAAAAAAA', shopId: 'shop-1' }),
  consumeRegistrationToken: async () => {
    if (state.tokenUsed) return null;
    state.tokenUsed = true;
    return { token: 'ZP-AAAAAAAAAAAA', shopId: 'shop-1' };
  },
});

stub('mongoose', {
  connection: {
    startSession: async () => ({
      // Mirrors the real thing on the point that matters: a plain `return` from
      // the callback commits; only a throw aborts.
      withTransaction: async (fn) => { await fn(); state.committed = true; },
      endSession: () => {},
    }),
  },
});

const { redeemShopInvite } = require('../services/redeemShopInvite');

const ACTIVE_SHOP = { _id: 'shop-1', name: 'Магазин 1', isActive: true, cityId: { name: 'Львів' } };
const SELLER = { _id: 'u1', telegramId: '111', role: 'seller', shopId: 'shop-0', firstName: 'A', lastName: 'B' };

const redeem = () => redeemShopInvite({ code: 'ZP-AAAAAAAAAAAA', sellerTelegramId: '111' });

beforeEach(() => {
  state.shopReads = [ACTIVE_SHOP];
  state.sellerReads = [SELLER];
  state.tokenUsed = false;
  state.committed = false;
  state.migrateCalled = false;
  state.published = null;
});

describe('redeemShopInvite — the code survives every refusal', () => {
  it('moves the seller and burns the code on success', async () => {
    const res = await redeem();
    expect(res.ok).toBe(true);
    expect(state.migrateCalled).toBe(true);
    expect(state.tokenUsed).toBe(true);
    expect(state.published?.assignmentChanged).toBe(true);
    expect(state.published?.toShopId).toBe('shop-1');
  });

  it('keeps the code alive when the shop went inactive mid-flight', async () => {
    // Passes the pre-check outside the transaction, fails the re-check inside it.
    state.shopReads = [ACTIVE_SHOP, { ...ACTIVE_SHOP, isActive: false }];

    const res = await redeem();

    expect(res).toEqual({ ok: false, reason: 'shop_inactive' });
    expect(state.migrateCalled).toBe(false);
    expect(state.tokenUsed).toBe(false); // ← the whole point
  });

  it('keeps the code alive when the account stopped being a seller mid-flight', async () => {
    state.sellerReads = [SELLER, null];

    const res = await redeem();

    expect(res).toEqual({ ok: false, reason: 'not_seller' });
    expect(state.migrateCalled).toBe(false);
    expect(state.tokenUsed).toBe(false);
  });

  it('keeps the code alive when the seller is already on that shop', async () => {
    state.sellerReads = [SELLER, { ...SELLER, shopId: 'shop-1' }];

    const res = await redeem();

    expect(res).toEqual({ ok: false, reason: 'same_shop' });
    expect(state.migrateCalled).toBe(false);
    expect(state.tokenUsed).toBe(false);
  });

  it('reports code_consumed when another message won the race', async () => {
    state.tokenUsed = true; // already burnt → peek finds nothing

    const res = await redeem();

    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(state.migrateCalled).toBe(false);
  });
});
