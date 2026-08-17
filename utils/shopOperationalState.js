'use strict';

/**
 * Canonical semantics for the CURRENT User -> Shop relationship.
 *
 * IMPORTANT: this module deliberately knows nothing about OrderingSession,
 * Order, CatalogReview or UI presentation. It answers only present-tense
 * topology/readiness questions. Historical/session projections may decorate
 * these facts, but must never redefine them.
 */
const ASSIGNED_SHOP_ROLES = Object.freeze(['seller', 'admin']);

function isAssignedShopRole(role) {
  return ASSIGNED_SHOP_ROLES.includes(String(role || ''));
}

function getUserOperationalIssues(user) {
  const issues = [];
  if (!user) return ['missing_user'];
  if (!isAssignedShopRole(user.role)) issues.push('role_not_shop_assignable');
  if (user.accountState === 'removed') issues.push('account_removed');
  if (user.botBlocked === true) issues.push('bot_blocked');
  return issues;
}

function isOperationalAssignedUser(user) {
  return getUserOperationalIssues(user).length === 0;
}

function getShopOperationalIssues(shop) {
  const issues = [];
  if (!shop) return ['missing_shop'];
  if (shop.isActive === false) issues.push('shop_inactive');
  if (!shop.deliveryGroupId) issues.push('delivery_group_missing');
  return issues;
}

function isOperationalShop(shop) {
  return getShopOperationalIssues(shop).length === 0;
}

function normalizeAssignedUser(user) {
  const telegramId = String(user?.telegramId || '');
  const name = user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || telegramId;
  const operationalIssues = getUserOperationalIssues(user);
  return {
    name,
    telegramId,
    username: String(user?.username || ''),
    role: String(user?.role || ''),
    operational: operationalIssues.length === 0,
    operationalIssues,
  };
}

function buildCurrentAssignment(users = [], { shop = null } = {}) {
  const assignedUsers = (Array.isArray(users) ? users : [])
    .filter((user) => isAssignedShopRole(user?.role))
    .map(normalizeAssignedUser);

  const shopIssues = shop ? getShopOperationalIssues(shop) : [];
  const operationalUsers = shopIssues.length === 0
    ? assignedUsers.filter((user) => user.operational)
    : [];

  return {
    assignedUsers,
    assignedCount: assignedUsers.length,
    hasAssigned: assignedUsers.length > 0,
    operationalCount: operationalUsers.length,
    hasOperationalUser: operationalUsers.length > 0,
    shopOperational: shopIssues.length === 0,
    shopOperationalIssues: shopIssues,
  };
}

function assertAssignableShopRole(role, appError) {
  if (!isAssignedShopRole(role)) {
    throw appError('validation_failed', { field: 'role' });
  }
}

function assertOperationalShop(shop, appError) {
  if (!shop) throw appError('shop_not_found');
  if (shop.isActive === false) throw appError('shop_inactive');
  if (!shop.deliveryGroupId) throw appError('shop_no_delivery_group');
}

module.exports = {
  ASSIGNED_SHOP_ROLES,
  isAssignedShopRole,
  getUserOperationalIssues,
  isOperationalAssignedUser,
  getShopOperationalIssues,
  isOperationalShop,
  normalizeAssignedUser,
  buildCurrentAssignment,
  assertAssignableShopRole,
  assertOperationalShop,
};
