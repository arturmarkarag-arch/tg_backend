'use strict';
const Order = require('../models/Order');
const User = require('../models/User');
const Shop = require('../models/Shop');
const PickingTask = require('../models/PickingTask');
const { logShopTransition } = require('./shopAudit');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');
const { getOrderOwnershipState } = require('../utils/orderOwnership');

// Unassign a seller from their shop. While ordering is still open, an active
// Order may be PARKED so it can follow the seller on a later assignment. Once
// ordering closes (or picking starts), the seller is only the author: the Order
// stays owned by its shop/session and User.shopId changes independently.
// Dedicated conflict-repair code may explicitly opt into parking a frozen Order.
//
// All writes are scoped to the passed Mongo session.
async function unassignSellerAndPark({ session, seller, fromShopId, actor, reason, allowFrozenOrderPark = false }) {
  const shopIdStr = fromShopId ? String(fromShopId) : (seller.shopId ? String(seller.shopId) : '');
  const fromShop = shopIdStr
    ? await Shop.findById(shopIdStr, 'deliveryGroupId').session(session).lean()
    : null;
  const prevGroupId = fromShop?.deliveryGroupId ? String(fromShop.deliveryGroupId) : null;

  const parkedIds = [];
  const leftInPipelineIds = [];
  const shopOwnedIds = [];

  if (shopIdStr) {
    // Match by BOTH shopId and buyerSnapshot.shopId (ObjectId + string forms).
    // Legacy/direct-add orders may have a null top-level shopId while
    // buyerSnapshot.shopId holds the real shop — top-level only would skip them.
    const activeOrders = await Order.find(
      activeOrderShopFilter(shopIdStr, { buyerTelegramId: String(seller.telegramId) }),
    ).session(session);

    for (const ord of activeOrders) {
      const ownership = await getOrderOwnershipState(ord, { session });
      if (ownership.frozen && !allowFrozenOrderPark) {
        shopOwnedIds.push(String(ord._id));
        continue;
      }

      const inPipeline = await PickingTask.exists({
        'items.orderId': ord._id,
        status: { $in: ['pending', 'locked', 'completed'] },
      }).session(session);
      if (inPipeline) { leftInPipelineIds.push(String(ord._id)); continue; }

      parkedIds.push(String(ord._id));
      ord.shopId = null;
      if (!ord.buyerSnapshot) ord.buyerSnapshot = {};
      ord.buyerSnapshot.shopId = null;
      ord.buyerSnapshot.shopName = '';
      ord.buyerSnapshot.shopCity = '';
      // CRITICAL: clear the delivery-group ref too — otherwise the order still
      // matches the OLD group's filter in taskBuilder ('buyerSnapshot.deliveryGroupId'),
      // gets pulled into the next picking build, and stamps PickingTask.items.shopName
      // as "невідомий магазин". The order follows the seller; the shop must be
      // left without seller AND without order, not orphaned in the picking pool.
      // migrateSellerShop will re-stamp deliveryGroupId on the next assignment.
      ord.buyerSnapshot.deliveryGroupId = '';
      ord.markModified('buyerSnapshot');
      ord.history.push({
        at: new Date(),
        by: String(actor?.telegramId || 'system'),
        byName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
        byRole: actor?.role || 'system',
        action: 'seller_unassigned_order_parked',
        meta: {
          fromShopId: shopIdStr,
          reason: reason || 'seller_unassigned',
          ownershipRepair: Boolean(ownership.frozen && allowFrozenOrderPark),
        },
      });
      await ord.save({ session });
    }
  }

  // Знімаємо тільки магазин — група/зона з нього ж і виводяться.
  await User.updateOne(
    { telegramId: seller.telegramId },
    { $set: { shopId: null } },
    { session },
  );

  await logShopTransition(session, {
    actorTelegramId: String(actor?.telegramId || ''),
    actorName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
    actorRole: actor?.role || '',
    sellerTelegramId: String(seller.telegramId),
    sellerName: [seller.firstName, seller.lastName].filter(Boolean).join(' '),
    fromShopId: shopIdStr,
    fromShopName: '',
    toShopId: '',
    toShopName: '',
    reason: reason || 'seller_unassigned',
    source: 'unassign',
    orderAction: parkedIds.length ? 'parked' : 'none',
    orderId: parkedIds[0] || '',
    orderShopBefore: shopIdStr,
    orderShopAfter: '',
    note: [
      parkedIds.length ? `parked=[${parkedIds.join(',')}]` : '',
      leftInPipelineIds.length ? `inPipelineStayed=[${leftInPipelineIds.join(',')}]` : '',
      shopOwnedIds.length ? `shopOwnedStayed=[${shopOwnedIds.join(',')}]` : '',
    ].filter(Boolean).join(' '),
  });

  return {
    fromShopId: shopIdStr || null,
    toShopId: null,
    sellerTelegramId: String(seller.telegramId),
    assignmentChanged: Boolean(shopIdStr),
    orderChanged: parkedIds.length > 0,
    prevGroupId,
    newGroupId: null,
    parkedOrderIds: parkedIds,
    leftInPipelineOrderIds: leftInPipelineIds,
    shopOwnedOrderIds: shopOwnedIds,
  };
}

module.exports = { unassignSellerAndPark };
