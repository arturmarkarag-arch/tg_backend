const User = require('../models/User');
const { getTelegramAuth, getInitDataFromRequest } = require('../utils/validateTelegramInitData');
const { verifySession } = require('../utils/jwt');
const { appError } = require('../utils/errors');

// Accepts either Telegram Mini App initData (x-telegram-initdata header) OR a
// browser session JWT (Authorization: Bearer). Whichever path matches, the
// request ends up with the same req.telegramId / req.telegramUser so every
// downstream requireTelegramRoles(...) keeps working unchanged.
async function telegramAuth(req, res, next) {
  const hasInitData = !!getInitDataFromRequest(req);

  let telegramId = '';
  let initData = null;
  let parsedData = null;

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
    // Browser path — verify the Bearer session token.
    const authHeader = req.headers?.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const session = verifySession(token);
    if (!session) {
      return next(appError('auth_required'));
    }
    telegramId = session.telegramId;
  }

  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    return next(appError('not_registered'));
  }
  // Blocked users must not retain access via either transport.
  if (user.botBlocked) {
    return next(appError('registration_blocked'));
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
