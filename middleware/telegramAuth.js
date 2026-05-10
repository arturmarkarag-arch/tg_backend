const User = require('../models/User');
const { getTelegramAuth } = require('../utils/validateTelegramInitData');

async function telegramAuth(req, res, next) {
  const { valid, parsedData, telegramId, initData, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    return res.status(403).json({ error: 'not_registered', message: 'User is not registered' });
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
      return res.status(401).json({ error: 'Telegram auth required' });
    }

    const user = req.telegramUser;
    if (!user || !allowed.includes(user.role)) {
      return res.status(403).json({ error: `Only ${allowed.join(' or ')} can access this endpoint` });
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
