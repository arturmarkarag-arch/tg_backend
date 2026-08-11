'use strict';
const User = require('../models/User');
const Order = require('../models/Order');
const { activeOrderShopFilter } = require('./orderShopFilter');

// Computes the conflict state of a shop from FRESH reads. Multiple assigned
// sellers are legal and NEVER constitute a conflict by themselves. The only
// conflict represented here is CURRENT active Orders from 2+ distinct buyers.
// `excludeTelegramId` is kept for callers that want to inspect the target state
// without counting the incoming seller's own order.
async function computeTargetShopState(toShopId, excludeTelegramId = '', session = null) {
  const sellerFilter = { shopId: String(toShopId), role: 'seller' };
  if (excludeTelegramId) sellerFilter.telegramId = { $ne: String(excludeTelegramId) };

  const sellersQ = User.find(sellerFilter).select('telegramId firstName lastName').lean();
  const ordersQ = Order.find(
    activeOrderShopFilter(toShopId),
    '_id buyerTelegramId',
  ).lean();
  if (session) { sellersQ.session(session); ordersQ.session(session); }
  const [sellers, activeOrders] = await Promise.all([sellersQ, ordersQ]);

  const distinctBuyers = new Set(
    activeOrders
      .map((o) => String(o.buyerTelegramId || ''))
      .filter((b) => b && b !== String(excludeTelegramId)),
  );

  // Seller presence alone is valid. Only competing active Order authors create
  // the pre-picking conflict.
  const hasConflict = distinctBuyers.size > 1;

  return { sellers, activeOrders, distinctBuyerCount: distinctBuyers.size, hasConflict };
}

module.exports = { computeTargetShopState };
