const User = require('../models/User');
const { verifySession, verifyTelegramSession, isSessionNotRevoked } = require('../utils/jwt');
const { readSessionCookie, readTelegramSessionCookie } = require('../utils/sessionCookie');
const { appError } = require('../utils/errors');
const { isRemovedUser } = require('../utils/userAccountState');

// Two first-party HttpOnly session transports converge here:
// - x-auth-context: telegram -> Telegram proof session cookie (created once from
//   signed initData by /auth/telegram/bootstrap);
// - default/browser          -> Google/browser session cookie with sessionVersion.
// Raw Telegram initData is NEVER accepted here and therefore cannot be replayed
// against arbitrary API endpoints.
async function telegramAuth(req, res, next) {
  const isTelegramContext = String(req.get('x-auth-context') || '').toLowerCase() === 'telegram';
  let telegramId = '';
  let browserSession = null;

  if (isTelegramContext) {
    const telegramSession = verifyTelegramSession(readTelegramSessionCookie(req));
    if (!telegramSession) return next(appError('auth_telegram_session_required'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
        && req.get('x-csrf-protection') !== '1') {
      return next(appError('auth_csrf_required'));
    }
    telegramId = telegramSession.telegramId;
    req.telegramSession = telegramSession;
  } else {
    const cookieToken = readSessionCookie(req);
    const session = verifySession(cookieToken);
    if (!session) return next(appError('auth_required'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
        && req.get('x-csrf-protection') !== '1') {
      return next(appError('auth_csrf_required'));
    }
    telegramId = session.telegramId;
    browserSession = session;
  }

  const user = await User.findOne({ telegramId })
    .select('_id telegramId role firstName lastName phoneNumber shopNumber shopId accountState botBlocked sessionVersion createdAt updatedAt')
    .lean();
  if (!user || isRemovedUser(user)) return next(appError('not_registered'));
  if (user.botBlocked) return next(appError('registration_blocked'));
  if (browserSession && !isSessionNotRevoked(browserSession, user)) return next(appError('auth_required'));

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
    if (!req.telegramId) return next(appError('auth_required'));
    const user = req.telegramUser;
    if (!user || !allowed.includes(user.role)) return next(appError('auth_role_required', { allowed }));
    req.user = user;
    next();
  };
}

module.exports = { telegramAuth, requireTelegramRole, requireTelegramRoles };
