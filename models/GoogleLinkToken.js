'use strict';
const mongoose = require('mongoose');

// One-time bearer token that authorizes a Google-account link in a system
// browser (the OAuth proof can't happen inside the Telegram webview). The token
// is minted by /auth/google/link/start (bound to a telegramId verified from
// initData), travels in the link URL, and is atomically consumed by
// /auth/google/link/complete. Kept deliberately minimal: short TTL + single use.
const schema = new mongoose.Schema({
  token:      { type: String, required: true, unique: true }, // crypto random, base64url
  telegramId: { type: String, required: true },               // who is linking (server-trusted)
  usedAt:     { type: Date, default: null },                  // set once on consume
  expiresAt:  { type: Date, required: true },                 // now + 10 min
}, { timestamps: true });

// TTL index — MongoDB reaps expired tokens automatically (expireAfterSeconds: 0
// = delete as soon as expiresAt passes), so spent/stale tokens don't accumulate.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GoogleLinkToken', schema);
