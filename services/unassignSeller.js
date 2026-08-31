'use strict';
const User = require('../models/User');
const Shop = require('../models/Shop');
const { logShopTransition } = require('./shopAudit');
const { ORDER_STATUS } = require('../utils/orderStatus');
const {
  resolveSellerAssignmentOrder,
  assertSellerAssignmentOrderInvariant,
} = require('./sellerOrderAssignment');

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
  const ownershipNow = new Date();

  if (shopIdStr) {
    const resolution = await resolveSellerAssignmentOrder({
      seller,
      session,
      now: ownershipNow,
      expectedOrderingSessionId: orderingSessionId,
      allowFrozenOverride: allowFrozenOrderPark,
    });

    // Keep the visibility/audit set complete: historical frozen Orders never move
    // with the User and never block a new assignment. Pipeline-owned rows are a
    // stronger subset and get their own audit bucket.
    for (const row of resolution.rows) {
      if (!row.frozen || !row.shop.consistent || row.shop.shopId !== shopIdStr) continue;
      const id = String(row.order._id);
      if (row.ownership?.reason === 'picking_pipeline') leftInPipelineIds.push(id);
      else shopOwnedIds.push(id);
    }

    const ord = resolution.transferOrder;
    if (ord) {
      const ownership = resolution.transferOwnership;

      // Even the explicit conflict-repair override may not park an Order that is
      // already represented in the physical picking pipeline. That is warehouse
      // ownership, not merely a closed ordering window.
      if (ownership?.reason === 'picking_pipeline') {
        const orderId = String(ord._id);
        if (!leftInPipelineIds.includes(orderId)) leftInPipelineIds.push(orderId);
      } else {
        parkedIds.push(String(ord._id));
        const previousStatus = String(ord.status || ORDER_STATUS.NEW);
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
            ownershipRepair: Boolean(ownership?.frozen && allowFrozenOrderPark),
          },
        });
        await ord.save({ session });
      }
    }
  }

  // Знімаємо тільки магазин — група/зона з нього ж і виводяться.
  await User.updateOne(
    { telegramId: seller.telegramId },
    // Unassignment invalidates any previous transfer banner in the very same
    // transaction. Historical User.history remains untouched.
    { $set: { shopId: null, shopTransferNotice: null } },
    { session },
  );

  await assertSellerAssignmentOrderInvariant({
    sellerTelegramId: seller.telegramId,
    currentShopId: null,
    session,
    now: ownershipNow,
  });

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
