function hasBaseLinkerPickingAccess(user) {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'baselinker';
}

function requireBaseLinkerPickingAccess(req, res, next) {
  if (!req?.telegramUser || !req?.telegramId) {
    const { appError } = require('./errors');
    return next(appError('auth_required'));
  }
  if (!hasBaseLinkerPickingAccess(req.telegramUser)) {
    const { appError } = require('./errors');
    return next(appError('auth_role_required', { allowed: ['admin', 'baselinker'] }));
  }
  req.user = req.telegramUser;
  return next();
}

module.exports = {
  hasBaseLinkerPickingAccess,
  requireBaseLinkerPickingAccess,
};
