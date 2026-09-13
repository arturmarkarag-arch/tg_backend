'use strict';
const { verifyTelegramSession } = require('../utils/jwt');
const { readTelegramSessionCookie } = require('../utils/sessionCookie');
const { appError } = require('../utils/errors');

function requireCookieCsrf(req) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
      && req.get('x-csrf-protection') !== '1') {
    throw appError('auth_csrf_required');
  }
}

// Identity-only middleware for pre-registration Telegram endpoints. Unlike the
// full telegramAuth middleware it does NOT require a User row, so a group member
// can legitimately reach registration-invite/register-request.
function telegramIdentity(req, res, next) {
  const session = verifyTelegramSession(readTelegramSessionCookie(req));
  if (!session) return next(appError('auth_telegram_session_required'));
  try { requireCookieCsrf(req); } catch (err) { return next(err); }
  req.telegramId = session.telegramId;
  req.telegramSession = session;
  next();
}

module.exports = { telegramIdentity, requireCookieCsrf };
