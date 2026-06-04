'use strict';
const mongoose = require('mongoose');

// One-time token for the SECURE Google-link flow (reverse direction).
//
// Minted INSIDE the mini-app where the telegramId is already proven by initData
// (POST /v1/telegram/google/link/start). The token therefore carries the PROVEN
// account identity — `telegramId` — and NOT the Google identity. The open half
// (the Google credential) is supplied later, in the system browser opened via
// Telegram.WebApp.openLink, by POST /v1/auth/google/link/complete.
//
// Why this direction is safe: the account being modified is fixed to whoever
// minted the token (you can only mint from your own initData). The worst an
// attacker can achieve by tricking someone into the browser step is attaching a
// Google account to the attacker's OWN account — no takeover. This is the inverse
// of the old, vulnerable scheme where the token carried googleSub and got glued
// to whatever Telegram opened a t.me deep link (confused-deputy / login-CSRF).
//
// Minimal by design: short TTL + single use (usedAt flipped atomically).
const schema = new mongoose.Schema({
  token:      { type: String, required: true, unique: true }, // crypto random, base64url
  telegramId: { type: String, required: true },               // proven via initData at mint time
  usedAt:     { type: Date, default: null },                  // set once on consume (in /complete)
  expiresAt:  { type: Date, required: true },                 // now + 10 min
}, { timestamps: true });

// TTL index — MongoDB reaps expired/spent tokens automatically.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GoogleLinkToken', schema);
