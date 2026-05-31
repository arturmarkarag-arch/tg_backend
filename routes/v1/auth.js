const express = require('express');
const crypto = require('crypto');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const GoogleLinkToken = require('../../models/GoogleLinkToken');
const { appError, asyncHandler } = require('../../utils/errors');
const { verifyTelegramWidget } = require('../../utils/telegramWidget');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../../utils/googleAuth');
const { signSession, verifySession, isSessionNotRevoked } = require('../../utils/jwt');
const { getBot } = require('../../telegramBot');
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

// The .env only carries the bot TOKEN, not its username — resolve it once via
// getMe and cache it (used for the config + the Google-link bot deep link).
let cachedBotUsername = null;
async function resolveBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const bot = getBot();
  if (bot) {
    try { const me = await bot.getMe(); cachedBotUsername = me?.username || null; }
    catch { /* bot not ready — caller will retry */ }
  }
  return cachedBotUsername;
}

router.get('/config', asyncHandler(async (req, res) => {
  res.json({
    botUsername: await resolveBotUsername(),
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

  if (!user) {
    // Valid Google, but not linked to any account yet. Don't hard-fail — offer
    // to LINK it via the bot (Google→Telegram): mint a one-time token bound to
    // this googleSub and hand back a bot deep link. The browser shows a
    // "continue in Telegram" button; the bot does the actual binding (where the
    // telegramId is Telegram-authenticated). After linking, the user signs in
    // with Google again and is found by sub.
    const token = crypto.randomBytes(32).toString('base64url');
    await GoogleLinkToken.create({
      token,
      googleSub: sub,
      googleEmail: email,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    });
    const username = await resolveBotUsername();
    return res.json({
      needsLink: true,
      email,
      pollToken: token, // browser polls /google/link/poll with this for auto-login
      botStartUrl: username ? `https://t.me/${username}?start=${token}` : null,
    });
  }

  if (user.botBlocked) throw appError('registration_blocked');

  const token = signSession(user.telegramId);
  res.json({ token, profile: await buildUserProfile(user) });
}));

// Browser polls this while the user finishes linking in the bot. Once the bot
// has bound the account (linkedTelegramId set), we issue a session JWT and
// delete the token (one-time login) — no second Google sign-in needed.
router.post('/google/link/poll', asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '');
  if (!token) return res.json({ status: 'expired' });

  const doc = await GoogleLinkToken.findOne({ token, expiresAt: { $gt: new Date() } }).lean();
  if (!doc) return res.json({ status: 'expired' });
  if (!doc.linkedTelegramId) return res.json({ status: 'pending' });

  // Atomically claim → exactly one session is issued for this token.
  const claimed = await GoogleLinkToken.findOneAndDelete({ token, linkedTelegramId: { $ne: null } });
  if (!claimed) return res.json({ status: 'pending' });

  const user = await User.findOne({ telegramId: claimed.linkedTelegramId }).lean();
  if (!user) throw appError('user_not_found');
  if (user.botBlocked) throw appError('registration_blocked');

  res.json({ status: 'ok', token: signSession(user.telegramId), profile: await buildUserProfile(user) });
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
