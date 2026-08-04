'use strict';
const mongoose = require('mongoose');

// Per-person registration invite. Minted server-side when we see a user join an
// allowed group (we know their telegramId), bound to THAT telegramId, single-use
// and short-lived. It travels in the group welcome link / the bot's register
// button, and register-request consumes it — together with a live getChatMember
// check (defense in depth). A token leaked to anyone else is useless: it only
// matches when the caller's authenticated telegramId equals token.telegramId.
const schema = new mongoose.Schema({
  token:      { type: String, required: true, unique: true }, // crypto random, base64url
  // The only id this token can register. NULL means "shop invite": an admin
  // minted it for a specific SHOP before knowing who would use it, so identity
  // cannot be pinned in advance. Such a token is gated by live group membership
  // instead (checked in the bot AND again on submit) and is still single-use, so
  // it opens the door exactly once for one member of the work group.
  telegramId: { type: String, default: null },
  // Set only on shop invites. When present it OVERRIDES whatever shop the form
  // sends: the whole point is that the newcomer cannot land on the wrong shop.
  shopId:     { type: String, default: null },
  usedAt:     { type: Date, default: null },                  // set once on consume
  expiresAt:  { type: Date, required: true },                 // now + 24h (a join→register window)
}, { timestamps: true });

schema.index({ telegramId: 1 });
// TTL — MongoDB reaps spent/expired invites automatically.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RegistrationToken', schema);
