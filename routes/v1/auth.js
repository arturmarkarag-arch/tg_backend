const express = require('express');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { appError, asyncHandler } = require('../../utils/errors');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../../utils/googleAuth');
const { signSession, verifySession, isSessionNotRevoked } = require('../../utils/jwt');
const { consumeGoogleLinkToken } = require('../../services/googleLinkToken');
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
// getMe and cache it (exposed in /config for clients that need the bot handle).
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

// Browser Google Sign-In. Body = { credential } (the Google ID token from the
// GIS button). PURE LOOKUP: we verify the token, then log in whichever account
// has linked this Google identity (`sub` — NOT the email). This route NEVER
// creates a link — linking is done from inside the mini-app (initData-proven)
// via /v1/telegram/google/link/start + /google/link/complete below. If the sub
// isn't linked to any account we tell the user to link it in the mini-app.
router.post('/google', asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const result = await verifyGoogleIdToken(req.body?.credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  const user = await User.findOne({ googleSub: result.sub }).lean();
  if (!user) throw appError('google_email_not_linked', { email: result.email });
  if (user.botBlocked) throw appError('registration_blocked');

  res.json({ token: signSession(user.telegramId), profile: await buildUserProfile(user) });
}));

// Completes the secure Google-link flow, called from the system browser opened
// via Telegram.WebApp.openLink. Body = { token, credential }. PUBLIC by design —
// the user has no session yet. Trust comes from the two proofs we glue here:
//   • token  → the PROVEN telegramId it was minted for (inside the mini-app)
//   • credential → the Google account signed in IN THIS browser (the user's own)
// Because the account is fixed by the token, the worst an attacker can do is
// attach a Google account to their OWN account — no takeover. On success we bind
// googleSub↔telegramId and issue a session JWT (auto-login in the browser).
router.post('/google/link/complete', asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const result = await verifyGoogleIdToken(req.body?.credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  // Atomically consume the token → exactly one binding per mint, no replay.
  const linkDoc = await consumeGoogleLinkToken(req.body?.token);
  if (!linkDoc) throw appError('google_link_invalid');

  const telegramId = String(linkDoc.telegramId);

  // This Google sub already belongs to a DIFFERENT account → refuse (one Google
  // = one account). Re-linking the same sub to its own account is a no-op pass.
  const owner = await User.findOne({ googleSub: result.sub }).select('telegramId').lean();
  if (owner && String(owner.telegramId) !== telegramId) {
    throw appError('google_sub_taken');
  }

  const user = await User.findOne({ telegramId }).lean();
  if (!user) await throwRegistrationState(telegramId);
  if (user.botBlocked) throw appError('registration_blocked');

  await User.updateOne(
    { telegramId },
    { $set: { googleSub: result.sub, googleEmail: result.email } },
  );
  const fresh = await User.findOne({ telegramId }).lean();
  res.json({ token: signSession(telegramId), profile: await buildUserProfile(fresh) });
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
