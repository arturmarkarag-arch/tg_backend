'use strict';
const crypto = require('crypto');
const GoogleLinkToken = require('../models/GoogleLinkToken');

const TTL_MS = 10 * 60 * 1000;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

async function issueGoogleLinkToken(telegramId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS);
  await GoogleLinkToken.create({
    token: hashSecret(token),
    telegramId: String(telegramId),
    expiresAt,
  });
  return token;
}

// Exchange the fragment bearer for a DIFFERENT browser secret. Only the browser
// secret survives after this call, and it is stored client-side only as HttpOnly.
async function bootstrapGoogleLinkToken(token) {
  if (!token) return null;
  const browserSecret = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const doc = await GoogleLinkToken.findOneAndUpdate(
    {
      token: hashSecret(token),
      browserSessionHash: null,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        browserSessionHash: hashSecret(browserSecret),
        bootstrappedAt: now,
      },
    },
    { new: true },
  ).lean();
  return doc ? { browserSecret, telegramId: String(doc.telegramId) } : null;
}

async function peekGoogleLinkBrowserSession(browserSecret, session = null) {
  if (!browserSecret) return null;
  return GoogleLinkToken.findOne({
    browserSessionHash: hashSecret(browserSecret),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }, null, session ? { session } : undefined).lean();
}

async function consumeGoogleLinkBrowserSession(browserSecret, session) {
  if (!browserSecret || !session) return null;
  const now = new Date();
  return GoogleLinkToken.findOneAndUpdate(
    {
      browserSessionHash: hashSecret(browserSecret),
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { new: true, session },
  ).lean();
}

module.exports = {
  issueGoogleLinkToken,
  bootstrapGoogleLinkToken,
  peekGoogleLinkBrowserSession,
  consumeGoogleLinkBrowserSession,
  hashSecret,
};
