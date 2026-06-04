'use strict';
const crypto = require('crypto');
const GoogleLinkToken = require('../models/GoogleLinkToken');

// Mirrors services/registrationToken.js: a short-lived, single-use token bound
// to a telegramId. See models/GoogleLinkToken.js for the security rationale
// (reverse-direction: the token carries the PROVEN account, not the Google id).
const TTL_MS = 10 * 60 * 1000; // 10 min — just enough to finish Google in the browser

// Mint a fresh single-use link token bound to this (initData-proven) telegramId.
async function issueGoogleLinkToken(telegramId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS);
  await GoogleLinkToken.create({ token, telegramId: String(telegramId), expiresAt });
  return token;
}

// Atomically consume: flips usedAt only if the token is unused AND unexpired.
// Returns the doc (carrying telegramId) on success, null otherwise. The caller
// then binds googleSub to that telegramId.
async function consumeGoogleLinkToken(token) {
  if (!token) return null;
  const now = new Date();
  return GoogleLinkToken.findOneAndUpdate(
    { token: String(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
}

module.exports = { issueGoogleLinkToken, consumeGoogleLinkToken };
