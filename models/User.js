const mongoose = require('mongoose');

const UserHistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: String, default: 'system' },
  byName: { type: String, default: '' },
  byRole: { type: String, default: 'system' },
  action: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const UserSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true },
    role: { type: String, enum: ['seller', 'warehouse', 'admin'], default: 'seller' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    // Google identity key for browser sign-in. Proven via OAuth (verifyIdToken),
    // never typed by hand. Empty string = not linked. This — not googleEmail —
    // is what /auth/google matches on, so a changed Gmail address can't be used
    // to squat another account.
    googleSub: { type: String, default: '' },
    // Linked Google account email — now DISPLAY ONLY (+ one-time migration bridge
    // in /auth/google for accounts linked before googleSub existed). Not a key.
    // Lowercased/trimmed on save; queries must normalize the same way.
    googleEmail: { type: String, default: '', lowercase: true, trim: true },
    shopNumber: { type: String, default: '' },
    // Магазин — ЄДИНИЙ звʼязок продавця з групою доставки:
    //     User.shopId → Shop.deliveryGroupId → DeliveryGroup
    // Полів deliveryGroupId/warehouseZone тут свідомо НЕМАЄ. Це були
    // денормалізовані копії заради швидкого читання, і їх правильність трималася
    // на тому, що КОЖЕН шлях зміни магазину не забуде зробити каскад
    // (User.updateMany у shops.js). Один пропущений endpoint = продавець у групі A,
    // магазин у групі B. Похідні значення тепер обчислюються з магазину в місці
    // використання; API-контракт (профіль /v1/telegram, список користувачів) віддає
    // їх так само, як раніше.
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    // Legacy shift-модель: docs/architecture/technical-debt.md#стара-логіка-зміни-складу
    isWarehouseManager: { type: Boolean, default: false },
    isOnShift: { type: Boolean, default: false },
    shiftZone: {
      startBlock: { type: Number, default: null },
      endBlock: { type: Number, default: null },
    },
    botBlocked: { type: Boolean, default: false },
    // Soft-removal state. `removed` closes ALL application access but keeps the
    // row as historical information. Missing field on legacy rows is treated as
    // active for backwards compatibility; successful self-registration can
    // reactivate the same row instead of creating a duplicate telegramId.
    accountState: { type: String, enum: ['active', 'removed'], default: 'active' },
    removedAt: { type: Date, default: null },
    removedByTelegramId: { type: String, default: '' },
    // Browser-session revocation. Any JWT issued (iat) strictly before this
    // timestamp is rejected. Set by POST /v1/auth/logout so "Вийти" actually
    // invalidates every previously issued token for this account.
    sessionsValidFrom: { type: Date, default: null },
    botLastActivityAt: { type: Date, default: null },
    botLastSessionAt: { type: Date, default: null },
    // Real application open marker. Updated whenever an authenticated profile is
    // bootstrapped (Telegram Mini App or browser session). Older accounts may be
    // null until their first open after this field was introduced.
    lastAppOpenedAt: { type: Date, default: null },
    miniAppState: {
      lastViewedProductId: { type: String, default: '' },
      currentIndex: { type: Number, default: 0 },
      currentPage: { type: Number, default: 0 },
      viewMode: { type: String, enum: ['carousel', 'grid'], default: 'carousel' },
      updatedAt: { type: Date, default: null },
    },
    cartState: {
      orderItems:          { type: Map, of: Number, default: {} },
      orderItemIds:        { type: [String], default: [] },
      lastOrderPositions:  { type: Number, default: 0 },
      navigationSessionId: { type: String, default: '' },
      lastViewedProductId:    { type: String, default: '' },
      lastViewedOrderNumber:  { type: Number, default: 0 },
      currentIndex:           { type: Number, default: 0 },
      currentPage:            { type: Number, default: 0 },
      updatedAt:              { type: Date, default: null },
    },
    isOnline: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
    history: { type: [UserHistoryEntrySchema], default: [] },
  },
  { timestamps: true }
);

// Unique only among accounts that actually linked a Gmail. The default ''
// (and legacy docs with no field) are excluded, so they never collide.
UserSchema.index(
  { googleEmail: 1 },
  { unique: true, partialFilterExpression: { googleEmail: { $gt: '' } } },
);

// Same partial-unique guarantee for the OAuth subject id: at most one account
// per Google identity. Docs without a linked Google ('' / missing) are excluded.
UserSchema.index(
  { googleSub: 1 },
  { unique: true, partialFilterExpression: { googleSub: { $gt: '' } } },
);

module.exports = mongoose.model('User', UserSchema);
