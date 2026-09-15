const express = require('express');
const mongoose = require('mongoose');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { appError, asyncHandler } = require('../../utils/errors');
const { verifyGoogleIdToken, isConfigured: googleConfigured } = require('../../utils/googleAuth');
const { signSession, verifySession, verifyTelegramSession, isSessionNotRevoked } = require('../../utils/jwt');
const {
  bootstrapGoogleLinkToken,
  peekGoogleLinkBrowserSession,
  consumeGoogleLinkBrowserSession,
} = require('../../services/googleLinkToken');
const {
  readSessionCookie,
  readTelegramSessionCookie,
  readGoogleLinkCookie,
  setSessionCookie,
  clearSessionCookie,
  setTelegramSessionCookie,
  clearTelegramSessionCookie,
  setGoogleLinkCookie,
  clearGoogleLinkCookie,
} = require('../../utils/sessionCookie');
const { bootstrapTelegramSession } = require('../../services/telegramSession');
const { createAuthRateLimit } = require('../../middleware/authRateLimit');
const { getBot } = require('../../telegramBot');
const { buildUserProfile } = require('./telegram');
const { isRemovedUser } = require('../../utils/userAccountState');

const router = express.Router();
function positiveEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const generalAuthLimit = createAuthRateLimit({
  name: 'browser-auth',
  max: positiveEnvInt('AUTH_BROWSER_RATE_MAX', 300),
  windowMs: positiveEnvInt('AUTH_BROWSER_RATE_WINDOW_MS', 5 * 60 * 1000),
});
const linkAuthLimit = createAuthRateLimit({
  name: 'google-link',
  max: positiveEnvInt('AUTH_GOOGLE_LINK_RATE_MAX', 120),
  windowMs: positiveEnvInt('AUTH_GOOGLE_LINK_RATE_WINDOW_MS', 10 * 60 * 1000),
});

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

async function throwRegistrationState(telegramId, mongoSession = null) {
  let query = RegistrationRequest.findOne({
    telegramId,
    status: { $in: ['pending', 'blocked', 'rejected'] },
  });
  if (mongoSession) query = query.session(mongoSession);
  const request = await query.lean();
  if (request?.status === 'pending')  throw appError('registration_pending', { telegramId });
  if (request?.status === 'blocked')  throw appError('registration_blocked', { telegramId, reason: request.moderationReason || '' });
  if (request?.status === 'rejected') throw appError('registration_rejected', { telegramId, reason: request.moderationReason || '' });
  throw appError('not_registered', { telegramId });
}


function requireBrowserMutationHeader(req) {
  // Cookie auth is protected by SameSite (Strict in production) + CORS and this non-simple custom
  // header. Cross-site forms cannot manufacture it; cross-site JS must pass the
  // CORS preflight before the browser sends the mutation.
  if (readSessionCookie(req) && req.get('x-csrf-protection') !== '1') {
    throw appError('auth_csrf_required');
  }
}

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

// Telegram Mini App bootstrap. Raw initData is accepted ONLY here. The first
// successful use is recorded by SHA-256 digest in Mongo and exchanged for an
// HttpOnly first-party Telegram session cookie. A valid existing Telegram cookie
// makes reloads idempotent without consuming/replaying initData again.
router.post('/telegram/bootstrap', generalAuthLimit, asyncHandler(async (req, res) => {
  const initData = String(req.body?.initData || '');
  if (!initData) throw appError('init_data_required');

  // IMPORTANT: never trust an existing Telegram cookie before comparing it to
  // the identity in the CURRENT signed initData. Telegram clients can reuse the
  // same WebView cookie jar after the user switches Telegram accounts.
  const existing = verifyTelegramSession(readTelegramSessionCookie(req));
  const result = await bootstrapTelegramSession(initData, process.env.TELEGRAM_BOT_TOKEN, {
    existingTelegramId: existing?.telegramId || '',
  });
  if (!result.valid) {
    if (result.replayed) throw appError('auth_init_data_replayed');
    throw appError('auth_invalid_init_data', { reason: result.error });
  }

  // Same identity: keep the existing cookie. Different identity: the service
  // consumed the fresh initData and issued a token which replaces the old cookie.
  if (result.sessionToken) setTelegramSessionCookie(res, result.sessionToken);
  res.json({
    ok: true,
    telegramId: result.telegramId,
    user: result.parsedData?.user || null,
  });
}));

router.get('/config', asyncHandler(async (req, res) => {
  res.json({
    botUsername: await resolveBotUsername(),
    googleClientId: process.env.GOOGLE_AUTH_CLIENT_ID || '',
  });
}));

// Browser Google Sign-In. A successful login creates an HttpOnly session cookie;
// no bearer token is exposed to JavaScript or persisted in localStorage.
router.post('/google', generalAuthLimit, asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const result = await verifyGoogleIdToken(req.body?.credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  const user = await User.findOne({ googleSub: result.sub }).lean();
  if (!user) throw appError('google_email_not_linked', { email: result.email });
  if (isRemovedUser(user)) await throwRegistrationState(user.telegramId);
  if (user.botBlocked) throw appError('registration_blocked');

  const signedSession = signSession(user.telegramId, user.sessionVersion);
  setSessionCookie(res, signedSession);
  res.json({ profile: await buildUserProfile(user) });
}));

// Browser handoff bootstrap. The raw secret arrives ONLY in the URL fragment on
// the frontend, is POSTed once, exchanged for a different HttpOnly cookie secret
// and immediately disappears from JS/history. Calling without a token validates
// an already-bootstrapped cookie, which makes a normal browser refresh safe.
router.post('/google/link/bootstrap', linkAuthLimit, asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) {
    const bootstrapped = await bootstrapGoogleLinkToken(token);
    if (!bootstrapped) throw appError('google_link_invalid');
    setGoogleLinkCookie(res, bootstrapped.browserSecret);
    return res.json({ ok: true });
  }

  const existingSecret = readGoogleLinkCookie(req);
  const existing = await peekGoogleLinkBrowserSession(existingSecret);
  if (!existing) {
    clearGoogleLinkCookie(res);
    throw appError('google_link_invalid');
  }
  return res.json({ ok: true });
}));

// Final bind is atomic: Google ownership checks, User credential update and
// single-use link consumption either all commit or all roll back together.
router.post('/google/link/complete', linkAuthLimit, asyncHandler(async (req, res) => {
  if (!googleConfigured()) throw appError('google_auth_not_configured');

  const result = await verifyGoogleIdToken(req.body?.credential);
  if (!result) throw appError('google_invalid_token');
  if (!result.emailVerified) throw appError('google_email_unverified');

  const browserSecret = readGoogleLinkCookie(req);
  if (!browserSecret) throw appError('google_link_invalid');
  // Cookie-authenticated completion requires the non-simple CSRF header.
  if (readGoogleLinkCookie(req) && req.get('x-csrf-protection') !== '1') {
    throw appError('auth_csrf_required');
  }

  const mongoSession = await mongoose.connection.startSession();
  let fresh = null;
  try {
    await mongoSession.withTransaction(async () => {
      const linkDoc = await peekGoogleLinkBrowserSession(browserSecret, mongoSession);
      if (!linkDoc) throw appError('google_link_invalid');
      const telegramId = String(linkDoc.telegramId);

      const owner = await User.findOne({ googleSub: result.sub })
        .select('telegramId')
        .session(mongoSession)
        .lean();
      if (owner && String(owner.telegramId) !== telegramId) {
        throw appError('google_sub_taken');
      }

      const user = await User.findOne({ telegramId }).session(mongoSession).lean();
      if (!user || isRemovedUser(user)) await throwRegistrationState(telegramId, mongoSession);
      if (user.botBlocked) throw appError('registration_blocked');

      const subChanged = String(user.googleSub || '') !== String(result.sub);
      const update = {
        $set: { googleSub: result.sub, googleEmail: result.email },
      };
      if (subChanged) {
        update.$inc = { sessionVersion: 1 };
      }

      fresh = await User.findOneAndUpdate(
        { telegramId },
        update,
        { new: true, session: mongoSession },
      ).lean();

      const consumed = await consumeGoogleLinkBrowserSession(browserSecret, mongoSession);
      if (!consumed) throw appError('google_link_invalid');
    });
  } catch (err) {
    // Unique googleSub index is the final race-proof ownership backstop.
    if (err?.code === 11000) throw appError('google_sub_taken');
    throw err;
  } finally {
    await mongoSession.endSession();
  }

  clearGoogleLinkCookie(res);
  const signedSession = signSession(fresh.telegramId, fresh.sessionVersion);
  setSessionCookie(res, signedSession);
  res.json({ profile: await buildUserProfile(fresh) });
}));

// Browser session bootstrap. HttpOnly cookie is the only browser credential.
router.get('/me', generalAuthLimit, asyncHandler(async (req, res) => {
  const session = verifySession(readSessionCookie(req));
  if (!session) throw appError('auth_required');

  const user = await User.findOne({ telegramId: session.telegramId }).lean();
  if (!user || isRemovedUser(user)) await throwRegistrationState(session.telegramId);
  if (user.botBlocked) throw appError('registration_blocked');
  if (!isSessionNotRevoked(session, user)) throw appError('auth_required');

  res.json(await buildUserProfile(user));
}));

// Logout-all for browser sessions. Integer versioning closes the old same-second
// timestamp hole completely; clearing the cookie removes this browser's handle.
router.post('/logout', generalAuthLimit, asyncHandler(async (req, res) => {
  requireBrowserMutationHeader(req);
  const session = verifySession(readSessionCookie(req));
  if (session?.telegramId) {
    await User.updateOne(
      { telegramId: session.telegramId },
      { $inc: { sessionVersion: 1 } },
    );
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

module.exports = router;
