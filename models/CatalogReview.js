'use strict';
const mongoose = require('mongoose');

// A seller's self-declared "я переглянув усі товари" for one ordering session.
// Purely informational: the warehouse wants to know, before picking starts, which
// sellers actually walked the whole catalogue to the end and which merely dropped
// a few items in the cart. No business rule reads it — it gates nothing.
//
// One row per (session, seller). The mark is ONE-WAY: it can be set, never
// cleared, and it disappears on its own next cycle because the next session has a
// different sessionId. That keeps the board unambiguous — what staff saw a minute
// ago cannot vanish under them.
//
// shopId/shopName are snapshotted so the board still reads correctly if the seller
// is later moved to another shop mid-cycle (see [[parked-order-deliverygroup-invariant]]
// for why we never trust a live join for session-scoped facts).
const CatalogReviewSchema = new mongoose.Schema({
  // OrderingSession _id as a string — same convention as Order.orderingSessionId.
  sessionId:  { type: String, required: true },
  groupId:    { type: String, required: true },   // delivery group, for board queries

  telegramId: { type: String, required: true },
  userName:   { type: String, default: '' },

  shopId:     { type: String, default: '' },
  shopName:   { type: String, default: '' },

  at:         { type: Date, default: Date.now },

  // Where the seller stood when they pressed it — the catalogue size at that
  // moment. Cheap forensic breadcrumb for "he marked it on an empty catalogue".
  productCount: { type: Number, default: 0 },
}, { timestamps: false });

// The uniqueness that makes the POST idempotent: pressing twice is a no-op.
CatalogReviewSchema.index({ sessionId: 1, telegramId: 1 }, { unique: true });
// Board lookup: all marks of one session (shop-status, shift-board).
CatalogReviewSchema.index({ groupId: 1, sessionId: 1 });
// Retention: 180 days, same horizon as ShopAuditLog. Rows are tiny but there is
// no reason to keep a "переглянув каталог" flag from half a year ago.
CatalogReviewSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('CatalogReview', CatalogReviewSchema);
