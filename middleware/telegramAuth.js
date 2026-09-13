const User = require('../models/User');
const { getTelegramAuth, getInitDataFromRequest } = require('../utils/validateTelegramInitData');
const { verifySession, isSessionNotRevoked } = require('../utils/jwt');
const { readSessionCookie } = require('../utils/sessionCookie');
const { appError } = require('../utils/errors');
const { isRemovedUser } = require('../utils/userAccountState');
const LEGACY_BROWSER_COMPAT = process.env.AUTH_LEGACY_BROWSER_COMPAT !== 'false';

// Accepts either Telegram Mini App initData (x-telegram-initdata header) OR a
// browser HttpOnly session cookie (with a temporary legacy Bearer fallback). Whichever path matches, the
// request ends up with the same req.telegramId / req.telegramUser so every
// downstream requireTelegramRoles(...) keeps working unchanged.
async function telegramAuth(req, res, next) {
  const hasInitData = !!getInitDataFromRequest(req);

  let telegramId = '';
  let initData = null;
  let parsedData = null;
  let browserSession = null; // set only on the browser session path

  if (hasInitData) {
    // Mini-app path — unchanged. A present-but-invalid initData still fails
    // here (we do NOT fall through to JWT) so mini-app error semantics hold.
    const result = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
    if (!result.valid) {
      return next(appError('auth_invalid_init_data', { reason: result.error }));
    }
    if (!result.telegramId) {
      return next(appError('auth_telegram_id_missing'));
    }
    telegramId = result.telegramId;
    initData = result.initData;
    parsedData = result.parsedData;
  } else {
    // Browser path — prefer the HttpOnly cookie. Bearer remains a temporary
    // migration fallback for already-open clients from the previous release.
    const cookieToken = readSessionCookie(req);
    const authHeader = req.headers?.authorization || '';
    const bearer = LEGACY_BROWSER_COMPAT && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const session = verifySession(cookieToken || bearer);
    if (!session) {
      return next(appError('auth_required'));
    }
    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
        && req.get('x-csrf-protection') !== '1') {
      return next(appError('auth_csrf_required'));
    }
    telegramId = session.telegramId;
    browserSession = session;
  }

  // Authentication needs identity, role, assignment and revocation only.
  const user = await User.findOne({ telegramId })
    .select('_id telegramId role firstName lastName phoneNumber shopNumber shopId accountState botBlocked sessionVersion sessionsValidFrom createdAt updatedAt')
    .lean();
  if (!user || isRemovedUser(user)) {
    return next(appError('not_registered'));
  }
  // Blocked users must not retain access via either transport.
  if (user.botBlocked) {
    return next(appError('registration_blocked'));
  }
  // Browser session version must match the current DB version.
  if (browserSession && !isSessionNotRevoked(browserSession, user)) {
    return next(appError('auth_required'));
  }

  req.telegramInitData = initData;
  req.telegramParsedData = parsedData;
  req.telegramUser = user;
  req.telegramId = telegramId;
  next();
}

function requireTelegramRole(role) {
  return requireTelegramRoles([role]);
}

function requireTelegramRoles(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return async function (req, res, next) {
    if (!req.telegramId) {
      return next(appError('auth_required'));
    }

    const user = req.telegramUser;
    if (!user || !allowed.includes(user.role)) {
      return next(appError('auth_role_required', { allowed }));
    }

    req.user = user;
    next();
  };
}

module.exports = {
  telegramAuth,
  requireTelegramRole,
  requireTelegramRoles,
};
