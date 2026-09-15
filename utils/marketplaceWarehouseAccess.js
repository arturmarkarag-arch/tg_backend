'use strict';

function hasMarketplaceWarehouseAccess(user) {
  if (!user) return false;
  return user.role === 'admin';
}

function requireMarketplaceWarehouseAccess(req, res, next) {
  if (!req?.telegramUser || !req?.telegramId) {
    const { appError } = require('./errors');
    return next(appError('auth_required'));
  }
  if (!hasMarketplaceWarehouseAccess(req.telegramUser)) {
    const { appError } = require('./errors');
    return next(appError('auth_role_required', { allowed: ['admin'] }));
  }
  req.user = req.telegramUser;
  return next();
}

module.exports = { hasMarketplaceWarehouseAccess, requireMarketplaceWarehouseAccess };
