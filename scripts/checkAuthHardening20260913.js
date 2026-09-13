'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateTelegramInitData } = require('../utils/validateTelegramInitData');
const { verifyTelegramWidget } = require('../utils/telegramWidget');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${passed + failed} ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${passed + failed} ${label}`);
  }
}

function makeMiniInitData(botToken, authDate, hashOverride = null) {
  const raw = {
    auth_date: String(authDate),
    query_id: 'AAE-auth-hardening',
    user: JSON.stringify({ id: 12345, first_name: 'Security' }),
  };
  const dataCheckString = Object.keys(raw).sort().map((key) => `${key}=${raw[key]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  raw.hash = hashOverride || crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams(raw).toString();
}

function makeWidgetData(botToken, authDate, hashOverride = null) {
  const raw = { id: '12345', first_name: 'Security', auth_date: String(authDate) };
  const dataCheckString = Object.keys(raw).sort().map((key) => `${key}=${raw[key]}`).join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  raw.hash = hashOverride || crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return raw;
}

const botToken = '123456:AUTH_HARDENING_CONTRACT_TOKEN';
const now = Math.floor(Date.now() / 1000);

check(validateTelegramInitData(makeMiniInitData(botToken, now), botToken).valid === true,
  'Telegram Mini App valid signed initData is accepted');
check(validateTelegramInitData(makeMiniInitData(botToken, now, 'z'.repeat(64)), botToken).valid === false,
  'Telegram Mini App malformed 64-char non-hex hash is rejected without throwing');
check(validateTelegramInitData(makeMiniInitData(botToken, now + 120), botToken).valid === false,
  'Telegram Mini App future auth_date beyond skew is rejected');
check(validateTelegramInitData(makeMiniInitData(botToken, now + 30), botToken).valid === true,
  'Telegram Mini App small clock skew remains usable');
check(validateTelegramInitData(makeMiniInitData(botToken, now - 86401), botToken).valid === false,
  'Telegram Mini App expired initData is rejected');
check(verifyTelegramWidget(makeWidgetData(botToken, now, 'z'.repeat(64)), botToken).valid === false,
  'legacy Telegram Login Widget helper also rejects malformed hash safely');

const jwt = read('utils/jwt.js');
const cookies = read('utils/sessionCookie.js');
const authRoute = read('routes/v1/auth.js');
const authMiddleware = read('middleware/telegramAuth.js');
const linkService = read('services/googleLinkToken.js');
const linkModel = read('models/GoogleLinkToken.js');
const userModel = read('models/User.js');
const telegramRoute = read('routes/v1/telegram.js');
const app = read('app.js');
const rateLimit = read('middleware/authRateLimit.js');
const telegramSession = read('services/telegramSession.js');
const telegramUseModel = read('models/TelegramInitDataUse.js');
const socket = read('socket.js');

check(jwt.includes("const ALGORITHM = 'HS256'") && jwt.includes("algorithms: [ALGORITHM]") && jwt.includes("kind: 'browser'") && jwt.includes("kind: 'telegram'"),
  'browser and Telegram sessions are type-separated and HS256 verification is pinned');
check(jwt.includes('session.sessionVersion') && jwt.includes('=== currentVersion')
    && !jwt.includes('sessionsValidFrom') && !userModel.includes('sessionsValidFrom'),
  'session revocation uses exact version matching with no timestamp/legacy fallback');
check(userModel.includes('sessionVersion: { type: Number, default: 0'),
  'User persists monotonic browser sessionVersion');
check(cookies.includes('httpOnly: true') && cookies.includes("sameSite: IS_PRODUCTION ? 'strict' : 'lax'") && cookies.includes('secure: IS_PRODUCTION'),
  'browser session/link cookies are HttpOnly, Strict-SameSite and Secure in production');
check(cookies.includes("'__Host-zlotoweczka_session'") && cookies.includes("'__Host-zlotoweczka_telegram'") && cookies.includes("'__Host-zlotoweczka_google_link'"),
  'all production auth cookies use __Host- prefix');
check(authMiddleware.includes('readSessionCookie(req)') && authMiddleware.includes('readTelegramSessionCookie(req)')
    && authMiddleware.includes("req.get('x-csrf-protection') !== '1'")
    && !authMiddleware.includes('getInitDataFromRequest') && !authMiddleware.includes('x-telegram-initdata'),
  'protected API uses first-party HttpOnly cookies only and enforces mutation CSRF header');
check(authRoute.includes("router.post('/google/link/bootstrap'") && authRoute.includes('setGoogleLinkCookie'),
  'Google link raw handoff is exchanged for a separate HttpOnly cookie secret');
check(!authRoute.includes('AUTH_LEGACY_BROWSER_COMPAT') && !authMiddleware.includes('AUTH_LEGACY_BROWSER_COMPAT')
    && !authRoute.includes('bearerToken(') && !authMiddleware.includes("startsWith('Bearer ')")
    && authRoute.includes('verifySession(readSessionCookie(req))'),
  'legacy browser Bearer compatibility is removed; browser auth is cookie-only');
check(linkService.includes('token: hashSecret(token)') && linkService.includes('browserSessionHash: hashSecret(browserSecret)'),
  'Google link bearer secrets are hashed at rest');
check(linkModel.includes('browserSessionHash') && linkModel.includes('expiresAt'),
  'Google link model tracks browser handoff and expiry');
check(authRoute.includes('withTransaction') && authRoute.includes('consumeGoogleLinkBrowserSession(browserSecret, mongoSession)'),
  'Google credential update and one-time link consumption are transaction-bound');
check(authRoute.includes("$inc: { sessionVersion: 1 }") && authRoute.includes("router.post('/logout'"),
  'logout increments sessionVersion and revokes prior browser sessions immediately');
check(rateLimit.includes('redis.incr') && rateLimit.includes('localIncrement') && rateLimit.includes("appError('auth_rate_limited')"),
  'auth rate limit uses Redis with local fallback and explicit 429 path');
check(telegramRoute.includes("router.post('/google/link/start', googleLinkLimit") && telegramRoute.includes('registrationLimit'),
  'registration and Google-link minting have deliberately mild auth rate limits');
check(authRoute.includes('AUTH_BROWSER_RATE_MAX') && authRoute.includes('AUTH_GOOGLE_LINK_RATE_MAX')
    && telegramRoute.includes('TELEGRAM_AUTH_RATE_MAX') && telegramRoute.includes('TELEGRAM_REGISTRATION_RATE_MAX'),
  'auth rate limits keep mild defaults but can be tuned from environment');
check(app.includes("/^\\/api\\/v1\\/auth\\/google\\/link\\/bootstrap$/"),
  'Google link bootstrap is in the exact public pre-auth allowlist');

check(authRoute.includes("router.post('/telegram/bootstrap'") && authRoute.includes('bootstrapTelegramSession')
    && authRoute.includes('setTelegramSessionCookie'),
  'raw Telegram initData is accepted only by the one-time bootstrap exchange');
check(telegramSession.includes("createHash('sha256')") && telegramSession.includes('TelegramInitDataUse.create')
    && telegramSession.includes("err?.code === 11000"),
  'Telegram initData replay ledger stores only SHA-256 digest and rejects duplicate consumption');
check(telegramUseModel.includes('unique: true') && telegramUseModel.includes('expireAfterSeconds: 0'),
  'Telegram initData replay ledger has unique digest and TTL cleanup');
const startup = read('index.js');
check(startup.includes('TelegramInitDataUse.createIndexes()')
    && startup.indexOf('TelegramInitDataUse.createIndexes()') < startup.indexOf('server.listen('),
  'Telegram initData replay indexes are fail-fast startup prerequisites before listening');
check(telegramRoute.includes("telegramIdentity") && !telegramRoute.includes('getTelegramAuth(')
    && !telegramRoute.includes('getInitDataFromRequest('),
  'pre-registration routes authenticate from Telegram session cookie, not replayable initData');
check(socket.includes("auth?.context") && socket.includes('readTelegramSessionCookie')
    && !socket.includes('validateTelegramInitData') && !socket.includes('auth?.initData'),
  'Socket.IO Telegram auth uses HttpOnly Telegram session and never raw initData');

console.log(`\nAuth hardening backend 2026-09-13: ${passed}/${passed + failed} PASS`);
if (failed) process.exit(1);
