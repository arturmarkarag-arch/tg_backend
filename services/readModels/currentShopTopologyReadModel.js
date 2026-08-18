'use strict';

/**
 * CURRENT topology read model for the preparation/readiness board.
 *
 * This module intentionally imports no Order, OrderingSession, PickingTask or
 * CatalogReview model. That is a structural guarantee: opening next-session
 * preparation cannot accidentally inherit state from a previous/current cycle.
 */
const Shop = require('../../models/Shop');
const User = require('../../models/User');
const { getTelegramUsernameMap } = require('../../utils/telegramUsername');
const { ASSIGNED_SHOP_ROLES } = require('../../utils/shopOperationalState');
const { loadAnnouncementMembershipByTelegramId } = require('../announcementGroupMembership');
const { buildReadinessShopProjection } = require('../shopStatusProjection');

function toAssignedUser(user, usernameMap, membershipByTelegramId = new Map()) {
  return {
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.telegramId),
    telegramId: String(user.telegramId),
    username: usernameMap.get(String(user.telegramId)) || '',
    role: user.role,
    accountState: user.accountState || 'active',
    botBlocked: user.botBlocked === true,
    announcementGroupMember: membershipByTelegramId.get(String(user.telegramId)) ?? null,
    hasCart: false,
    hasOrder: false,
    catalogReviewedAt: null,
  };
}

function groupUsersByShop(users, usernameMap, membershipByTelegramId = new Map()) {
  const byShop = {};
  for (const user of users) {
    const shopId = String(user.shopId || '');
    if (!shopId) continue;
    if (!byShop[shopId]) byShop[shopId] = [];
    byShop[shopId].push(toAssignedUser(user, usernameMap, membershipByTelegramId));
  }
  return byShop;
}

async function buildCurrentShopTopologyReadModel(group) {
  const shops = await Shop.find({ deliveryGroupId: String(group._id), isActive: true })
    .select('name cityId deliveryGroupId isActive')
    .populate('cityId', 'name')
    .lean();
  const shopIds = shops.map((shop) => shop._id);

  const assignedUsers = shopIds.length
    ? await User.find({ role: { $in: ASSIGNED_SHOP_ROLES }, shopId: { $in: shopIds } })
      .select('shopId firstName lastName telegramId role accountState botBlocked')
      .lean()
    : [];
  const usernameMap = await getTelegramUsernameMap(assignedUsers.map((user) => user.telegramId));
  const membershipByTelegramId = await loadAnnouncementMembershipByTelegramId(
    assignedUsers.map((user) => user.telegramId),
  );
  const usersByShop = groupUsersByShop(assignedUsers, usernameMap, membershipByTelegramId);

  const shopStatuses = shops.map((shop) => buildReadinessShopProjection({
    shop,
    assignedUsers: usersByShop[String(shop._id)] || [],
  }));
  shopStatuses.sort((a, b) => String(a.shopName || '').localeCompare(String(b.shopName || ''), 'uk'));
  return shopStatuses;
}

module.exports = {
  buildCurrentShopTopologyReadModel,
  groupUsersByShop,
  toAssignedUser,
};
