'use strict';
const crypto = require('crypto');
const RegistrationToken = require('../models/RegistrationToken');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches the initData validity / join window

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

// Mint a single-use invite bound to a SHOP instead of a person — the admin hands
// the link to a newcomer whose telegramId is not known yet. Whoever redeems it
// (and passes the live group check) is registered onto exactly this shop, with
// no shop picker to get wrong.
async function issueShopRegistrationToken(shopId) {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await RegistrationToken.create({
    token, telegramId: null, shopId: String(shopId), expiresAt,
  });
  return token;
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
  issueShopRegistrationToken,
  peekRegistrationToken,
  consumeRegistrationToken,
};
