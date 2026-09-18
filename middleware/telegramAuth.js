const User = require('../models/User');
const { isSessionNotRevoked } = require('../utils/jwt');
const { readContextSessionProof } = require('./sessionProof');
const { appError } = require('../utils/errors');
const { isRemovedUser } = require('../utils/userAccountState');
const { readTelegramClientId, readTelegramSessionSlot } = require('../utils/telegramRequestIdentity');

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
    const telegramSessionSlot = readTelegramSessionSlot(req);
    const telegramSession = readContextSessionProof(req).session;
    if (!telegramSession) return next(appError('auth_telegram_session_required'));

    // Safety selector only: the header is not trusted as authentication. It is
    // derived from the current Telegram initData on the client and can only make
    // a request fail closed when a shared WebView cookie belongs to another
    // Telegram account. The signed cookie remains the actual credential.
    const expectedTelegramId = readTelegramClientId(req);
    if (expectedTelegramId && expectedTelegramId !== String(telegramSession.telegramId)) {
      return next(appError('auth_telegram_session_mismatch', { telegramId: expectedTelegramId }));
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
        && req.get('x-csrf-protection') !== '1') {
      return next(appError('auth_csrf_required'));
    }
    telegramId = telegramSession.telegramId;
    req.telegramSession = telegramSession;
  } else {
    const session = readContextSessionProof(req).session;
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
