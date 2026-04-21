const User = require('../models/User');
const { validateTelegramInitData } = require('../utils/validateTelegramInitData');

function getTelegramInitData(req) {
  return req.body?.initData || req.query?.initData || req.headers['x-telegram-initdata'] || req.headers['x-telegram-init-data'];
}

async function telegramAuth(req, res, next) {
  const initData = getTelegramInitData(req);
  if (!initData) {
    return res.status(401).json({ error: 'initData is required' });
  }

  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  const telegramId = String(parsedData.user?.id || parsedData.id || '');
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  req.telegramInitData = initData;
  req.telegramParsedData = parsedData;
  req.telegramUser = parsedData.user || null;
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

    const user = await User.findOne({ telegramId: req.telegramId }).lean();
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
