'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const RegistrationToken = require('../models/RegistrationToken');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches the initData validity / join window

// Shop links are short and human-readable (ZP-XXXXXXXXXXXX) because they are ALSO
// pasted into the bot by hand, not only tapped. Personal invites stay opaque —
// nobody retypes those.
const SHOP_CODE_RE = /^ZP-[0-9A-F]{12}$/;

function normalizeShopCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function looksLikeShopCode(raw) {
  return SHOP_CODE_RE.test(normalizeShopCode(raw));
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 chars, Telegram start-param safe
}

// Mint a fresh single-use invite bound to this telegramId.
async function issueRegistrationToken(telegramId) {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await RegistrationToken.create({ token, telegramId: String(telegramId), expiresAt });
  return token;
}

// Mint the ONE link an admin hands out for a shop. It is bound to the SHOP, not
// to a person — the admin does not know the recipient's telegramId in advance —
// and what it does is decided at redemption time by the bot:
//   • recipient already registered   → they are MOVED onto this shop;
//   • recipient has no account yet   → registration opens with this shop fixed
//                                      (gated by live group membership).
// Single-use either way, 24h. Minting a new one retires any previous unused link
// for the same shop, so exactly one code per shop is ever live.
//
// "Exactly one" needs BOTH guards below, and neither is optional:
//   • the LOCK serialises two admins (or two tabs) pressing the button at once —
//     without it both retire the old links and then both insert, leaving two live
//     codes for one shop;
//   • the TRANSACTION makes retire+insert all-or-nothing — without it a failed
//     insert leaves the shop with no live link at all, the previous one already
//     burnt.
// The retry loop wraps the WHOLE transaction on purpose: a duplicate-key error
// aborts the transaction server-side, so retrying `create` inside it would only
// hit "transaction aborted".
async function issueShopInvite(shopId) {
  return withLock(`shop:${String(shopId)}:invite`, async () => {
    const expiresAt = new Date(Date.now() + TTL_MS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = `ZP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const session = await mongoose.connection.startSession();
      try {
        await session.withTransaction(async () => {
          await RegistrationToken.updateMany(
            { shopId: String(shopId), telegramId: null, usedAt: null },
            { $set: { usedAt: new Date() } },
            { session },
          );
          await RegistrationToken.create(
            [{ token, telegramId: null, shopId: String(shopId), expiresAt }],
            { session },
          );
        });
        return token;
      } catch (err) {
        // 11000 → that code is already taken (astronomically unlikely). The whole
        // transaction rolled back, so nothing was retired either; try a new code.
        if (err?.code === 11000) continue;
        throw err;
      } finally {
        session.endSession();
      }
    }
    throw appError('shop_invite_failed');
  });
}

// Live shop invite by code, WITHOUT consuming it. Returns the token doc (carrying
// shopId) or null. Used by the bot to decide transfer-vs-registration before it
// commits to either.
async function peekShopInvite(code) {
  const token = normalizeShopCode(code);
  if (!SHOP_CODE_RE.test(token)) return null;
  const doc = await RegistrationToken.findOne({
    token, usedAt: null, expiresAt: { $gt: new Date() },
  }).lean();
  return doc?.shopId ? doc : null;
}

// Matches a personal token for THIS id, or any unclaimed shop invite. Callers
// MUST verify group membership themselves before honouring a shop invite —
// identity is not what gates those.
function ownershipFilter(telegramId) {
  return { $or: [{ telegramId: String(telegramId) }, { telegramId: null }] };
}

// Non-consuming check: is this token currently usable BY this telegramId?
// Returns the doc or null. Used by /start to decide reuse vs. re-issue.
async function peekRegistrationToken(token, telegramId) {
  if (!token) return null;
  return RegistrationToken.findOne({
    token: String(token),
    ...ownershipFilter(telegramId),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
}

// Atomically consume: flips usedAt only if the token is unused, unexpired AND
// usable by this telegramId. Returns the doc on success, null otherwise.
//
// PASS THE SESSION of the transaction that creates the User/RegistrationRequest.
// Burning the token outside that transaction means any later failure (shop went
// inactive, write conflict, resolveAndCreateUser throwing) leaves the person
// unregistered holding a dead single-use link — and for a SHOP invite the retry
// would fall back to a personal token, silently losing the shop binding that was
// the whole point.
async function consumeRegistrationToken(token, telegramId, session = null) {
  if (!token) return null;
  const now = new Date();
  return RegistrationToken.findOneAndUpdate(
    { token: String(token), ...ownershipFilter(telegramId), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true, ...(session ? { session } : {}) },
  );
}

module.exports = {
  issueRegistrationToken,
  issueShopInvite,
  peekShopInvite,
  peekRegistrationToken,
  consumeRegistrationToken,
  SHOP_CODE_RE,
  normalizeShopCode,
  looksLikeShopCode,
};
