'use strict';
const mongoose = require('mongoose');

// One-time token for the Google→Telegram linking flow. Minted by /auth/google
// when a browser user proves a Google identity (sub) that isn't linked to any
// account yet. It carries the proven googleSub (+ email for display) and travels
// in a bot deep link (t.me/<bot>?start=<token>). The bot's /start handler binds
// it: there the telegramId is Telegram-authenticated (ctx.from.id), so the final
// binding is googleSub(proven in browser) ↔ telegramId(proven in bot).
// Minimal by design: short TTL + single use.
const schema = new mongoose.Schema({
  token:       { type: String, required: true, unique: true }, // crypto random, base64url
  googleSub:   { type: String, required: true },               // proven via browser OAuth
  googleEmail: { type: String, default: '' },                  // for display / notification
  usedAt:      { type: Date, default: null },                  // set once on consume (in bot)
  expiresAt:   { type: Date, required: true },                 // now + 10 min
}, { timestamps: true });

// TTL index — MongoDB reaps expired/spent tokens automatically.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GoogleLinkToken', schema);
