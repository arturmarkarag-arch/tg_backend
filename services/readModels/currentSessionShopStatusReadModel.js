'use strict';

/**
 * CURRENT SESSION read model for the staff shop-status board.
 *
 * CURRENT assignment stays separate from SESSION/HISTORY participants. The
 * historical CatalogReview shop snapshot may change where a participant row is
 * DISPLAYED, but it never changes currentAssignment or command targets.
 */
const Shop = require('../../models/Shop');
const User = require('../../models/User');
const Order = require('../../models/Order');
const CatalogReview = require('../../models/CatalogReview');
const { findCurrentSessionId } = require('../../utils/getOrCreateSession');
const { getTelegramUsernameMap } = require('../../utils/telegramUsername');
const { ASSIGNED_SHOP_ROLES } = require('../../utils/shopOperationalState');
const { loadAnnouncementMembershipByTelegramId } = require('../announcementGroupMembership');
const { buildCurrentSessionShopProjection } = require('../shopStatusProjection');

function liveItem(item) {
  return Boolean(item?.productId) && !item.cancelled && !item.skipped && !item.voided;
}

function resolveOrderShopId(order) {
  return String(order?.shopId || order?.buyerSnapshot?.shopId || '');
}

function mapSeller(user, usernameMap, membershipByTelegramId = new Map()) {
  return {
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.telegramId),
    telegramId: String(user.telegramId),
    username: usernameMap.get(String(user.telegramId)) || '',
    role: user.role,
    accountState: user.accountState || 'active',
    botBlocked: user.botBlocked === true,
    announcementGroupMember: membershipByTelegramId.get(String(user.telegramId)) ?? null,
    // Legacy User.cartState has no orderingSessionId and is never evidence of
    // work in this exact session. Orders below are the sole authority.
    hasCart: false,
  };
}

function buildCartItemsByShop() {
  return {};
}

function buildOrderedBuyerIdsByShop(orders) {
  const result = {};
  for (const order of orders) {
    const shopId = resolveOrderShopId(order);
    if (!shopId || !order.buyerTelegramId) continue;
    if (!result[shopId]) result[shopId] = new Set();
    result[shopId].add(String(order.buyerTelegramId));
  }
  return result;
}

function earliestOrderAt(shop) {
  const times = (shop.orders || [])
    .map((order) => (order.createdAt ? new Date(order.createdAt).getTime() : null))
    .filter((time) => time !== null);
  return times.length ? Math.min(...times) : Infinity;
}

async function buildCurrentSessionShopStatusReadModel(group, { windowOpen }) {
  const shops = await Shop.find({ deliveryGroupId: String(group._id), isActive: true })
    .select('name cityId deliveryGroupId isActive')
    .populate('cityId', 'name')
    .lean();
  const shopIds = shops.map((shop) => shop._id);
  const shopIdStrs = shopIds.map(String);
  const currentSessionId = await findCurrentSessionId(String(group._id), group.orderingSchedule);

  const orders = currentSessionId && shopIds.length ? await Order.find({
    $or: [
      { shopId: { $in: shopIds } },
      { 'buyerSnapshot.shopId': { $in: shopIds } },
      { 'buyerSnapshot.shopId': { $in: shopIdStrs } },
    ],
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('buyerSnapshot shopId buyerTelegramId items orderNumber _id createdAt history').lean() : [];

  // Historical debris is useful after the window closes, but must not pollute a
  // live ordering window. This remains diagnostic-only and never becomes current
  // session ownership.
  const staleOrders = windowOpen ? [] : await Order.find({
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: currentSessionId ? { $ne: currentSessionId } : { $ne: null },
  }).select('buyerSnapshot buyerTelegramId items orderNumber _id createdAt orderingSessionId').lean();

  const sellers = shopIds.length ? await User.find({
    role: { $in: ASSIGNED_SHOP_ROLES },
    shopId: { $in: shopIds },
  }).select('shopId firstName lastName telegramId role accountState botBlocked').lean() : [];

  const usernameMap = await getTelegramUsernameMap([
    ...sellers.map((seller) => seller.telegramId),
    ...orders.map((order) => order.buyerTelegramId),
    ...staleOrders.map((order) => order.buyerTelegramId),
  ]);
  const membershipByTelegramId = await loadAnnouncementMembershipByTelegramId(
    sellers.map((seller) => seller.telegramId),
  );

  const sellersByShop = {};
  for (const seller of sellers) {
    const shopId = String(seller.shopId || '');
    if (!shopId) continue;
    if (!sellersByShop[shopId]) sellersByShop[shopId] = [];
    sellersByShop[shopId].push(mapSeller(seller, usernameMap, membershipByTelegramId));
  }

  const buyerTelegramIds = [...new Set([...orders, ...staleOrders]
    .map((order) => order.buyerTelegramId)
    .filter(Boolean))];
  const buyers = buyerTelegramIds.length
    ? await User.find({ telegramId: { $in: buyerTelegramIds } })
      .select('telegramId firstName lastName role')
      .lean()
    : [];
  const buyerInfoById = {};
  for (const buyer of buyers) {
    buyerInfoById[String(buyer.telegramId)] = {
      name: [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || buyer.telegramId,
      role: buyer.role,
      username: usernameMap.get(String(buyer.telegramId)) || '',
    };
  }

  const ordersByShop = {};
  const orderedProductIdsByShop = {};
  for (const order of orders) {
    const shopId = resolveOrderShopId(order);
    if (!shopId) continue;
    if (!ordersByShop[shopId]) ordersByShop[shopId] = [];
    const reassignEntry = (order.history || []).slice().reverse().find((row) => row.action === 'shop_reassigned');
    const wasReassigned = Boolean(reassignEntry);
    ordersByShop[shopId].push({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: order.buyerTelegramId,
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      buyerRole: buyerInfoById[String(order.buyerTelegramId)]?.role || 'seller',
      buyerUsername: buyerInfoById[String(order.buyerTelegramId)]?.username || '',
      itemCount: (order.items || []).filter(liveItem).length,
      createdAt: order.createdAt,
      wasReassigned,
      fromShopName: wasReassigned ? (reassignEntry?.meta?.from?.shopName || null) : null,
      reassignedByName: wasReassigned ? (reassignEntry?.byName || null) : null,
      reassignedByRole: wasReassigned ? (reassignEntry?.byRole || null) : null,
      reassignedByTelegramId: wasReassigned ? (reassignEntry?.by || null) : null,
      reassignedAt: wasReassigned ? (reassignEntry?.at || null) : null,
    });
    if (!orderedProductIdsByShop[shopId]) orderedProductIdsByShop[shopId] = new Set();
    for (const item of order.items || []) {
      if (liveItem(item)) orderedProductIdsByShop[shopId].add(String(item.productId));
    }
  }

  const actorIds = new Set();
  for (const shopOrders of Object.values(ordersByShop)) {
    for (const order of shopOrders) {
      if (order.reassignedByTelegramId) actorIds.add(String(order.reassignedByTelegramId));
    }
  }
  if (actorIds.size) {
    const actors = await User.find({ telegramId: { $in: [...actorIds] } })
      .select('telegramId firstName lastName role')
      .lean();
    const actorsById = {};
    for (const actor of actors) {
      actorsById[String(actor.telegramId)] = {
        name: [actor.firstName, actor.lastName].filter(Boolean).join(' ') || String(actor.telegramId),
        role: actor.role,
      };
    }
    for (const shopOrders of Object.values(ordersByShop)) {
      for (const order of shopOrders) {
        const actor = order.reassignedByTelegramId
          ? actorsById[String(order.reassignedByTelegramId)]
          : null;
        if (!actor) continue;
        order.reassignedByName = actor.name;
        order.reassignedByRole = actor.role;
      }
    }
  }

  const cartItemsByShop = buildCartItemsByShop(sellers);
  const orderedBuyerIdsByShop = buildOrderedBuyerIdsByShop(orders);

  // No current session means no current-session historical participant roster.
  // This explicit guard prevents null/legacy CatalogReview documents from being
  // mistaken for the current cycle.
  const reviewMarks = currentSessionId ? await CatalogReview.find(
    { groupId: String(group._id), sessionId: currentSessionId },
    'telegramId userName shopId shopName at',
  ).lean() : [];
  const markBySeller = new Map(reviewMarks.map((mark) => [String(mark.telegramId), mark]));
  const markedSellersBySnapshotShop = {};
  const sellerByTelegramId = new Map(sellers.map((seller) => [String(seller.telegramId), seller]));
  const renderedShopIds = new Set(shopIdStrs);

  for (const mark of reviewMarks) {
    const snapshotShopId = String(mark.shopId || '');
    if (!renderedShopIds.has(snapshotShopId)) continue;
    const telegramId = String(mark.telegramId);
    const liveSeller = sellerByTelegramId.get(telegramId);
    if (liveSeller && String(liveSeller.shopId) === snapshotShopId) continue;
    if (!markedSellersBySnapshotShop[snapshotShopId]) markedSellersBySnapshotShop[snapshotShopId] = [];
    markedSellersBySnapshotShop[snapshotShopId].push({
      name: liveSeller
        ? ([liveSeller.firstName, liveSeller.lastName].filter(Boolean).join(' ') || telegramId)
        : (mark.userName || telegramId),
      telegramId,
      role: liveSeller?.role || 'seller',
      hasCart: false,
      movedAway: true,
    });
  }

  const shopStatuses = shops.map((shop) => {
    const shopId = String(shop._id);
    const currentAssignedUsers = sellersByShop[shopId] || [];
    const orderedBuyerIds = orderedBuyerIdsByShop[shopId] || new Set();
    const sessionParticipants = [
      ...currentAssignedUsers.filter((seller) => {
        const mark = markBySeller.get(String(seller.telegramId));
        if (!mark || !renderedShopIds.has(String(mark.shopId || ''))) return true;
        return String(mark.shopId) === shopId;
      }),
      ...(markedSellersBySnapshotShop[shopId] || []),
    ].map((seller) => ({
      ...seller,
      hasOrder: orderedBuyerIds.has(String(seller.telegramId)),
      catalogReviewedAt: markBySeller.get(String(seller.telegramId))?.at || null,
    }));

    return buildCurrentSessionShopProjection({
      shop,
      assignedUsers: currentAssignedUsers,
      sessionParticipants,
      shopOrders: ordersByShop[shopId] || [],
      orderedBuyerIds,
      orderedItemCount: orderedProductIdsByShop[shopId]?.size || 0,
      cartItemCount: cartItemsByShop[shopId] || 0,
    });
  });

  shopStatuses.sort((a, b) => {
    const aTime = earliestOrderAt(a);
    const bTime = earliestOrderAt(b);
    if (aTime !== bTime) return aTime - bTime;
    return String(a.shopName || '').localeCompare(String(b.shopName || ''), 'uk');
  });

  return {
    currentSessionId,
    staleOrders: staleOrders.map((order) => ({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: String(order.buyerTelegramId || ''),
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      buyerUsername: buyerInfoById[String(order.buyerTelegramId)]?.username || '',
      shopName: order.buyerSnapshot?.shopName || '—',
      shopCity: order.buyerSnapshot?.shopCity || '',
      itemCount: (order.items || []).filter(liveItem).length,
      orderingSessionId: order.orderingSessionId || '',
      createdAt: order.createdAt,
    })),
    shops: shopStatuses,
  };
}

module.exports = {
  buildCurrentSessionShopStatusReadModel,
  buildCartItemsByShop,
  buildOrderedBuyerIdsByShop,
  earliestOrderAt,
  liveItem,
  mapSeller,
  resolveOrderShopId,
};
