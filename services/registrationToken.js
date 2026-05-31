'use strict';
const crypto = require('crypto');
const RegistrationToken = require('../models/RegistrationToken');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches the initData validity / join window

// Mint a fresh single-use invite bound to this telegramId.
async function issueRegistrationToken(telegramId) {
  const token = crypto.randomBytes(24).toString('base64url'); // 32 chars, Telegram start-param safe
  const expiresAt = new Date(Date.now() + TTL_MS);
  await RegistrationToken.create({ token, telegramId: String(telegramId), expiresAt });
  return token;
}

// Non-consuming check: is this token currently valid FOR this telegramId?
// Returns the doc or null. Used by /start to decide reuse vs. re-issue.
async function peekRegistrationToken(token, telegramId) {
  if (!token) return null;
  return RegistrationToken.findOne({
    token: String(token),
    telegramId: String(telegramId),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
}

// Atomically consume: flips usedAt only if the token is unused, unexpired AND
// belongs to this telegramId. Returns the doc on success, null otherwise.
async function consumeRegistrationToken(token, telegramId) {
  if (!token) return null;
  const now = new Date();
  return RegistrationToken.findOneAndUpdate(
    { token: String(token), telegramId: String(telegramId), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
}

module.exports = { issueRegistrationToken, peekRegistrationToken, consumeRegistrationToken };
