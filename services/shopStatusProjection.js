'use strict';

/**
 * Canonical READ-MODEL boundary for shop status screens.
 *
 * Data classes are intentionally explicit:
 *   currentAssignment   -> present-tense User -> Shop topology (business truth)
 *   sessionParticipants -> session/history projection used only for presentation
 *   orders              -> current OrderingSession facts
 *
 * A presentation roster may differ from the current assignment after a seller is
 * moved mid-cycle. It must NEVER redefine assignment business flags or command
 * targets. Keep that rule here rather than re-implementing it in every route/UI.
 */
const { buildCurrentAssignment } = require('../utils/shopOperationalState');

function shopIdentity(shop) {
  return {
    shopId: String(shop?._id || shop?.shopId || ''),
    shopName: String(shop?.name || shop?.shopName || ''),
    shopCity: String(shop?.cityId?.name || shop?.shopCity || ''),
  };
}

function displayName(users = []) {
  const names = (Array.isArray(users) ? users : [])
    .map((user) => String(user?.name || '').trim())
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : null;
}

function buildReadinessShopProjection({ shop, assignedUsers = [] }) {
  const currentAssignment = buildCurrentAssignment(assignedUsers, { shop });
  const currentParticipants = Array.isArray(assignedUsers) ? assignedUsers : [];

  return {
    ...shopIdentity(shop),
    currentAssignment,
    // Readiness has no session/history roster. `sellers` remains a rolling
    // compatibility alias for the current table renderer only.
    sessionParticipants: [],
    sellers: currentParticipants,
    sellerName: displayName(currentParticipants),
    sellerCount: currentAssignment.assignedCount,
    cartItemCount: 0,
    orderedItemCount: 0,
    orders: [],
    hasConflict: false,
    hasMultipleSellers: currentAssignment.assignedCount > 1,
    hasSellerOrderMismatch: false,
  };
}

function buildCurrentSessionShopProjection({
  shop,
  assignedUsers = [],
  sessionParticipants = [],
  shopOrders = [],
  orderedBuyerIds = new Set(),
  orderedItemCount = 0,
  cartItemCount = 0,
}) {
  const currentAssignment = buildCurrentAssignment(assignedUsers, { shop });
  const participants = Array.isArray(sessionParticipants) ? sessionParticipants : [];
  const orders = Array.isArray(shopOrders) ? shopOrders : [];
  const buyers = orderedBuyerIds instanceof Set
    ? orderedBuyerIds
    : new Set(Array.isArray(orderedBuyerIds) ? orderedBuyerIds.map(String) : []);

  const assignedWithOrder = currentAssignment.assignedUsers
    .filter((user) => buyers.has(String(user.telegramId)));
  const hasMultipleSellers = currentAssignment.assignedCount > 1;
  const hasSellerOrderMismatch = hasMultipleSellers
    && orders.length > 0
    && assignedWithOrder.length !== currentAssignment.assignedCount;
  const uniqueOrderBuyers = new Set(
    orders.map((order) => String(order?.buyerTelegramId || '')).filter(Boolean),
  );

  return {
    ...shopIdentity(shop),
    currentAssignment,
    sessionParticipants: participants,
    // Compatibility aliases are presentation only. Business decisions MUST use
    // currentAssignment / explicit derived fields above.
    sellers: participants,
    sellerName: displayName(participants),
    sellerCount: participants.length,
    cartItemCount: Number(cartItemCount) || 0,
    orderedItemCount: Number(orderedItemCount) || 0,
    orders,
    hasConflict: uniqueOrderBuyers.size > 1,
    hasMultipleSellers,
    hasSellerOrderMismatch,
  };
}

module.exports = {
  buildReadinessShopProjection,
  buildCurrentSessionShopProjection,
};
