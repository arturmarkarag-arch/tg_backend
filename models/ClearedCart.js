'use strict';
const mongoose = require('mongoose');

// Soft-delete snapshot of a seller's cart taken right before it is wiped during a
// shop transfer / displacement. Kept indefinitely ("just in case"); the UI only
// offers a Restore button for 7 days after clearedAt.
const ClearedCartSchema = new mongoose.Schema({
  ownerTelegramId:    { type: String, required: true, index: true },
  ownerName:          { type: String, default: '' },
  orderItems:         { type: Map, of: Number, default: {} },
  orderItemIds:       { type: [String], default: [] },
  lastOrderPositions: { type: Number, default: 0 },

  clearedAt:          { type: Date, default: Date.now, index: true },
  clearedBy:          { type: String, default: '' },     // admin telegramId
  clearedByName:      { type: String, default: '' },
  reason:             { type: String, default: '' },

  // Shop the cart belonged to when it was cleared (context only)
  shopId:             { type: String, default: '' },
  shopName:           { type: String, default: '' },

  // Restore audit
  restoredAt:         { type: Date, default: null },
  restoredBy:         { type: String, default: '' },
  restoredByName:     { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ClearedCart', ClearedCartSchema);
