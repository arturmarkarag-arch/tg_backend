'use strict';
const mongoose = require('mongoose');

// Durable audit trail for EVERY seller↔shop transition and what happened to the
// seller's active order. Lets us reconstruct "where did the order go" without
// dumping the DB. Written from the migration chokepoints.
const ShopAuditLogSchema = new mongoose.Schema({
  at:               { type: Date, default: Date.now },

  actorTelegramId:  { type: String, default: '' },
  actorName:        { type: String, default: '' },
  actorRole:        { type: String, default: '' },

  sellerTelegramId: { type: String, default: '', index: true },
  sellerName:       { type: String, default: '' },

  fromShopId:       { type: String, default: '' },
  fromShopName:     { type: String, default: '' },
  toShopId:         { type: String, default: '' },
  toShopName:       { type: String, default: '' },

  // Which code path produced this transition (reason string passed by caller).
  reason:           { type: String, default: '' },
  // Logical source: 'migrate' | 'unassign' | 'raw_leak'
  source:           { type: String, default: '' },

  // What happened to the seller's active order:
  // 'moved'  — followed the seller to the new shop
  // 'parked' — detached (shopId=null), will follow on next assignment
  // 'none'   — seller had no active order
  // 'left_behind' — order stayed on a shop the seller no longer belongs to (BUG signal)
  orderAction:      { type: String, default: 'none' },
  orderId:          { type: String, default: '' },
  orderShopBefore:  { type: String, default: '' },
  orderShopAfter:   { type: String, default: '' },

  // True when, after this transition, the resulting shop holds active orders
  // from 2+ distinct buyers (a conflict was created/observed).
  conflictDetected: { type: Boolean, default: false },
  note:             { type: String, default: '' },
}, { timestamps: true });

// Retention: 180 days. This is the durable "where did the order go" audit, so it
// is kept far longer than the 3-day BotInteractionLog, but it is NOT permanent —
// the TTL (on the event time `at`) reaps entries older than half a year so the
// collection cannot grow without bound. Doubles as the time-range/sort index.
ShopAuditLogSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('ShopAuditLog', ShopAuditLogSchema);
