'use strict';
const mongoose = require('mongoose');

// A seller's self-declared "я переглянув усі товари" for one ordering session.
// Purely informational: the warehouse wants to know, before picking starts, which
// sellers actually walked the whole catalogue to the end and which merely dropped
// a few items in the cart. No business rule reads it — it gates nothing.
//
// One row per (session, seller) — the mark belongs to the PERSON, not to the
// shop they happened to be on. The seller walks ONE catalogue (the warehouse's),
// so moving them to another shop mid-cycle must not make them owe a second press:
// the unique index below physically prevents one anyway. Every reader therefore
// keys on telegramId alone (routes/picking.js shift-board, routes/deliveryGroups.js
// shop-status) — keying on `telegramId|shopId` listed a moved seller twice, once
// marked and once not, with a counter stuck at "1 / 2" for a single human.
//
// The mark is ONE-WAY: it can be set, never cleared, and it disappears on its own
// next cycle because the next session has a different sessionId. That keeps the
// board unambiguous — what staff saw a minute ago cannot vanish under them.
//
// shopId/shopName are a SNAPSHOT of where the seller stood when they pressed it.
// They are NOT part of the identity of the mark (that is sessionId+telegramId), but
// they ARE what the boards display: the whole point of the feature is "хто на якому
// магазині натиснув", so a marked seller is always rendered against the SNAPSHOT
// shop — never against wherever they were moved afterwards, which would silently
// rewrite history. Only an UNMARKED seller is rendered against their current shop.
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
