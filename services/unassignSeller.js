'use strict';
const Order = require('../models/Order');
const User = require('../models/User');
const PickingTask = require('../models/PickingTask');

// Unassign a seller from their shop and PARK their active orders that the
// warehouse has not started picking yet (shopId=null so the order follows the
// seller on the next assignment via migrateSellerShop). Orders already in the
// picking pipeline stay on the shop — the warehouse owns them.
//
// All writes are scoped to the passed Mongo session.
async function unassignSellerAndPark({ session, seller, fromShopId, actor, reason }) {
  const shopIdStr = fromShopId ? String(fromShopId) : (seller.shopId ? String(seller.shopId) : '');

  if (shopIdStr) {
    const activeOrders = await Order.find({
      buyerTelegramId: String(seller.telegramId),
      shopId: shopIdStr,
      status: { $in: ['new', 'in_progress'] },
    }).session(session);

    for (const ord of activeOrders) {
      const inPipeline = await PickingTask.exists({
        'items.orderId': ord._id,
        status: { $in: ['pending', 'locked', 'completed'] },
      }).session(session);
      if (inPipeline) continue;

      ord.shopId = null;
      if (!ord.buyerSnapshot) ord.buyerSnapshot = {};
      ord.buyerSnapshot.shopId = null;
      ord.buyerSnapshot.shopName = '';
      ord.buyerSnapshot.shopCity = '';
      ord.markModified('buyerSnapshot');
      ord.history.push({
        at: new Date(),
        by: String(actor?.telegramId || 'system'),
        byName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
        byRole: actor?.role || 'system',
        action: 'seller_unassigned_order_parked',
        meta: { fromShopId: shopIdStr, reason: reason || 'seller_unassigned' },
      });
      await ord.save({ session });
    }
  }

  await User.updateOne(
    { telegramId: seller.telegramId },
    { $set: { shopId: null, deliveryGroupId: '', warehouseZone: '' } },
    { session },
  );
}

module.exports = { unassignSellerAndPark };
