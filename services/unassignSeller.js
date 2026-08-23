'use strict';
const Order = require('../models/Order');
const User = require('../models/User');
const Shop = require('../models/Shop');
const PickingTask = require('../models/PickingTask');
const { logShopTransition } = require('./shopAudit');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');
const { getOrderOwnershipState } = require('../utils/orderOwnership');
const { ORDER_STATUS } = require('../utils/orderStatus');

// Unassign a seller from their shop. While ordering is still open, an active
// Order may be PARKED by status (`new_unassign`) so it can follow the seller on
// a later assignment. PARKING MUST NOT destroy Order ownership: shopId,
// buyerSnapshot shop/group fields and orderingSessionId remain intact. The parked
// status alone removes it from active/picking/blocker predicates. Once ordering
// closes (or picking starts), the seller is only the author: the Order stays
// owned by its shop/session and User.shopId changes independently. Dedicated
// conflict-repair code may explicitly opt into parking a frozen Order.
//
// All writes are scoped to the passed Mongo session.
async function unassignSellerAndPark({
  session,
  seller,
  fromShopId,
  actor,
  reason,
  allowFrozenOrderPark = false,
  orderingSessionId = null,
}) {
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
      activeOrderShopFilter(shopIdStr, {
        buyerTelegramId: String(seller.telegramId),
        ...(orderingSessionId ? { orderingSessionId: String(orderingSessionId) } : {}),
      }),
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
      const previousStatus = String(ord.status || ORDER_STATUS.NEW);
      // The Order keeps immutable/provenance ownership. `new_unassign` is the
      // ONLY fact needed to remove it from operational work while the seller has
      // no current shop assignment. Do not null shop/group/session to influence
      // taskBuilder; taskBuilder already reads ACTIVE order statuses.
      ord.status = ORDER_STATUS.NEW_UNASSIGN;
      ord.history.push({
        at: new Date(),
        by: String(actor?.telegramId || 'system'),
        byName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
        byRole: actor?.role || 'system',
        action: 'seller_unassigned_order_parked',
        meta: {
          fromShopId: shopIdStr,
          reason: reason || 'seller_unassigned',
          previousStatus,
          status: ORDER_STATUS.NEW_UNASSIGN,
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
    orderShopAfter: shopIdStr,
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
