const User = require('../models/User');
const { getTelegramAuth } = require('../utils/validateTelegramInitData');
const { appError } = require('../utils/errors');

async function telegramAuth(req, res, next) {
  const { valid, parsedData, telegramId, initData, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return next(appError('auth_invalid_init_data', { reason: error }));
  }

  if (!telegramId) {
    return next(appError('auth_telegram_id_missing'));
  }

  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    return next(appError('not_registered'));
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
