'use strict';
const User = require('../models/User');
const Order = require('../models/Order');

function countCartItems(cartState) {
  const items = cartState?.orderItems;
  if (!items) return 0;
  const obj = items instanceof Map ? Object.fromEntries(items) : items;
  return Object.values(obj).reduce((s, q) => s + (Number(q) || 0), 0);
}

// Computes the conflict state of a shop from FRESH reads: every seller assigned to
// it and every active order on it (by distinct buyer). `excludeTelegramId` lets the
// caller ignore an incoming seller so a transfer that merely displaces ONE seller
// is not mistaken for a pre-existing conflict.
async function computeTargetShopState(toShopId, excludeTelegramId = '', session = null) {
  const sellerFilter = { shopId: String(toShopId), role: 'seller' };
  if (excludeTelegramId) sellerFilter.telegramId = { $ne: String(excludeTelegramId) };

  const sellersQ = User.find(sellerFilter).select('telegramId firstName lastName cartState').lean();
  const ordersQ = Order.find(
    { shopId: String(toShopId), status: { $in: ['new', 'in_progress'] } },
    '_id buyerTelegramId',
  ).lean();
  if (session) { sellersQ.session(session); ordersQ.session(session); }
  const [sellers, activeOrders] = await Promise.all([sellersQ, ordersQ]);

  const distinctBuyers = new Set(
    activeOrders
      .map((o) => String(o.buyerTelegramId || ''))
      .filter((b) => b && b !== String(excludeTelegramId)),
  );

  // A shop is "in conflict" when it cannot be cleanly resolved by displacing a
  // single seller: 2+ other sellers, or active orders from 2+ distinct buyers.
  const hasConflict = sellers.length > 1 || distinctBuyers.size > 1;

  return { sellers, activeOrders, distinctBuyerCount: distinctBuyers.size, hasConflict };
}

module.exports = { countCartItems, computeTargetShopState };
