'use strict';
const mongoose = require('mongoose');

// One-time replay ledger for Telegram WebApp initData. The raw signed payload is
// never stored; only SHA-256(initData) is persisted. A unique digest makes the
// first successful bootstrap atomic across processes/workers. TTL removes the
// marker after Telegram's own initData validity window has elapsed.
const schema = new mongoose.Schema({
  digest:          { type: String, required: true, unique: true },
  telegramId:      { type: String, required: true },
  // SHA-256 of the non-secret per-WebView slot. Legacy rows may not have it;
  // they are claimed atomically on the first upgraded bootstrap.
  sessionSlotHash: { type: String, default: undefined },
  expiresAt:       { type: Date, required: true },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ telegramId: 1 });

module.exports = mongoose.model('TelegramInitDataUse', schema);
