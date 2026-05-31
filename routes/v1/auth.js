const express = require('express');
const crypto = require('crypto');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const GoogleLinkToken = require('../../models/GoogleLinkToken');
const { appError, asyncHandler } = require('../../utils/errors');
const { verifyTelegramWidget } = require('../../utils/telegramWidget');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../../utils/googleAuth');
const { signSession, verifySession, isSessionNotRevoked } = require('../../utils/jwt');
const { getTelegramAuth } = require('../../utils/validateTelegramInitData');
const { getBot, notifyGoogleLinked } = require('../../telegramBot');
const { buildUserProfile } = require('./telegram');

const router = express.Router();

// Mirrors the "user not found" branch of POST /v1/telegram/me so the browser
// login surfaces the same registration states the mini-app already handles.
async function throwRegistrationState(telegramId) {
  const request = await RegistrationRequest.findOne({
    telegramId,
    status: { $in: ['pending', 'blocked', 'rejected'] },
  }).lean();
  if (request?.status === 'pending')  throw appError('registration_pending', { telegramId });
  if (request?.status === 'blocked')  throw appError('registration_blocked', { telegramId });
  if (request?.status === 'rejected') throw appError('registration_rejected', { telegramId });
  throw appError('not_registered', { telegramId });
}

let cachedBotUsername = null;

// The .env only carries the bot TOKEN, not its username — but the Telegram
// Login Widget needs the username. Resolve it once via getMe and cache it.
router.get('/config', asyncHandler(async (req, res) => {
  if (!cachedBotUsername) {
    const bot = getBot();
    if (bot) {
      try {
        const me = await bot.getMe();
        cachedBotUsername = me?.username || null;
      } catch { /* bot not ready — client will retry */ }
    }
  }
  res.json({
    botUsername: cachedBotUsername,
    // Single-sourced so the client doesn't need its own build-time env.
    googleClientId: process.env.GOOGLE_AUTH_CLIENT_ID || '',
  });
}));

// Google Sign-In callback. Body = { credential } (the Google ID token from
// the GIS button). We verify it locally, then log in whichever account has
// linked this Google identity (`sub` — NOT the email). Same JWT + profile shape
// as the Telegram widget path.
router.post('/google', asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const credential = req.body?.credential;
  const result = await verifyGoogleIdToken(credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  const { sub, email } = result;
  let user = await User.findOne({ googleSub: sub }).lean();

  // Migration bridge (trust-on-first-use): accounts linked before googleSub
  // existed only have googleEmail. The FIRST time such a user signs in we match
  // by email and seal the sub onto the account — every later login is sub-keyed.
  // We only bridge when the account has NO sub yet (an account already sealed to
  // a different sub is never reachable by a stranger who controls the email).
  if (!user) {
    const byEmail = await User.findOne({ googleEmail: email }).lean();
    if (byEmail && !byEmail.googleSub) {
      await User.updateOne({ _id: byEmail._id }, { $set: { googleSub: sub } });
      user = { ...byEmail, googleSub: sub };
    }
  }

  if (!user) throw appError('google_email_not_linked', { email });
  if (user.botBlocked) throw appError('registration_blocked');

  const token = signSession(user.telegramId);
  res.json({ token, profile: await buildUserProfile(user) });
}));

// ── Google account linking (system-browser OAuth proof) ──────────────────────
// Google blocks OAuth inside the Telegram webview (disallowed_useragent), so the
// mini-app opens the link page in the system browser via Telegram.WebApp.openLink.
// A one-time token (bound server-side to the telegramId) carries the identity —
// never a tg= URL param.

// Start: mini-app calls this WITH initData. We mint a single-use token bound to
// the verified telegramId and hand back the system-browser link URL.
router.post('/google/link/start', asyncHandler(async (req, res) => {
  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await GoogleLinkToken.create({ token, telegramId, expiresAt });

  const base = String(process.env.WEB_APP_URL || '').replace(/\/+$/, '');
  res.json({ linkUrl: `${base}/link-google?lt=${token}` });
}));

// Complete: the /link-google page (running in the system browser, NOT logged in)
// posts the Google credential + the link token. Authorization is the token alone;
// the telegramId comes from the server-stored record, never from the request.
router.post('/google/link/complete', asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const { credential, lt } = req.body || {};
  const result = await verifyGoogleIdToken(credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  // Atomically consume the token: only an unused, unexpired token flips usedAt.
  // A replay/expired/forged token matches nothing → google_link_invalid.
  const now = new Date();
  const linkDoc = await GoogleLinkToken.findOneAndUpdate(
    { token: String(lt || ''), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!linkDoc) throw appError('google_link_invalid');

  const telegramId = linkDoc.telegramId; // server-trusted, NOT from the request
  const { sub, email } = result;

  // Collision guards.
  const subOwner = await User.findOne({ googleSub: sub }).select('telegramId').lean();
  if (subOwner && String(subOwner.telegramId) !== String(telegramId)) {
    throw appError('google_sub_taken');
  }
  const target = await User.findOne({ telegramId }).lean();
  if (!target) throw appError('user_not_found');
  if (target.googleSub && target.googleSub !== sub) {
    throw appError('google_already_linked');
  }

  await User.updateOne({ telegramId }, { $set: { googleSub: sub, googleEmail: email } });

  // Notify the user in Telegram so a silent hijack can't go unnoticed.
  notifyGoogleLinked(telegramId, email).catch((err) =>
    console.warn('[auth] notifyGoogleLinked failed:', err?.message || err));

  res.json({ ok: true, email });
}));

// Unlink: clears the Google identity from the caller's account. /v1/auth is in
// publicApiPaths (no global telegramAuth), so — like /me and link/start — this
// verifies initData itself. Called from the mini-app profile, where initData is
// present. Changing Google = unlink + link again.
router.post('/google/unlink', asyncHandler(async (req, res) => {
  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  const result = await User.updateOne(
    { telegramId },
    { $set: { googleSub: '', googleEmail: '' } },
  );
  if (!result.matchedCount) throw appError('user_not_found');
  res.json({ ok: true });
}));

// Telegram Login Widget callback. Body = the object the widget passes to
// data-onauth (id, first_name, auth_date, hash, ...). On success returns a
// JWT + the same profile shape as POST /v1/telegram/me.
router.post('/telegram', asyncHandler(async (req, res) => {
  const data = req.body || {};
  const { valid, error, telegramId } = verifyTelegramWidget(data, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  const user = await User.findOne({ telegramId }).lean();
  if (!user) await throwRegistrationState(telegramId);
  if (user.botBlocked) throw appError('registration_blocked', { telegramId });

  const token = signSession(telegramId);
  res.json({ token, profile: await buildUserProfile(user) });
}));

// Browser session bootstrap — verifies the Bearer JWT and returns the profile.
router.get('/me', asyncHandler(async (req, res) => {
  const auth = req.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = verifySession(token);
  if (!session) throw appError('auth_required');

  const user = await User.findOne({ telegramId: session.telegramId }).lean();
  if (!user) await throwRegistrationState(session.telegramId);
  if (user.botBlocked) throw appError('registration_blocked');
  if (!isSessionNotRevoked(session.iat, user)) throw appError('auth_required');

  res.json(await buildUserProfile(user));
}));

// Real logout: bump the user's sessionsValidFrom so EVERY token issued before
// now (this device and any other) is rejected on the next request. Idempotent
// and best-effort — an expired/invalid token still yields { ok: true } so the
// client can always clear local state.
router.post('/logout', asyncHandler(async (req, res) => {
  const auth = req.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = verifySession(token);
  if (session?.telegramId) {
    await User.updateOne(
      { telegramId: session.telegramId },
      { $set: { sessionsValidFrom: new Date() } },
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
