const express = require('express');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { appError, asyncHandler } = require('../../utils/errors');
const { verifyTelegramWidget } = require('../../utils/telegramWidget');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../../utils/googleAuth');
const { signSession, verifySession } = require('../../utils/jwt');
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
// linked this Gmail. Same JWT + profile shape as the Telegram widget path.
router.post('/google', asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const credential = req.body?.credential;
  const result = await verifyGoogleIdToken(credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  const user = await User.findOne({ googleEmail: result.email }).lean();
  if (!user) throw appError('google_email_not_linked', { email: result.email });
  if (user.botBlocked) throw appError('registration_blocked');

  const token = signSession(user.telegramId);
  res.json({ token, profile: await buildUserProfile(user) });
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

  res.json(await buildUserProfile(user));
}));

// Bearer tokens are stateless — the client just drops it. Kept for symmetry.
router.post('/logout', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
