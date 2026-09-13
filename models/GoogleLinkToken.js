'use strict';
const mongoose = require('mongoose');

// Short-lived Google-link handoff. Neither bearer secret is stored in plaintext:
// - token: SHA-256 of the fragment secret minted inside Telegram and used once to bootstrap
//   the system browser;
// - browserSessionHash: secret held only in an HttpOnly cookie after bootstrap.
// Final Google binding + token consumption happen in one Mongo transaction.
const schema = new mongoose.Schema({
  // Keep the historical field name so the existing unique `token_1` index is
  // deployment-compatible. The VALUE is now SHA-256(secret), never the bearer.
  token:              { type: String, required: true, unique: true },
  telegramId:         { type: String, required: true },
  browserSessionHash: { type: String, default: null },
  bootstrappedAt:     { type: Date, default: null },
  usedAt:             { type: Date, default: null },
  expiresAt:          { type: Date, required: true },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ browserSessionHash: 1 });

module.exports = mongoose.model('GoogleLinkToken', schema);
