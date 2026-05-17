'use strict';
const ClearedCart = require('../models/ClearedCart');

function cartItemsToObject(orderItems) {
  if (!orderItems) return {};
  return orderItems instanceof Map ? Object.fromEntries(orderItems) : { ...orderItems };
}

function countItems(obj) {
  return Object.values(obj).reduce((s, q) => s + (Number(q) || 0), 0);
}

/**
 * Snapshot a seller's cart into ClearedCart BEFORE it is wiped. No-op when the
 * cart is empty (nothing worth restoring). Scoped to the passed session so it
 * commits/aborts atomically with the wipe.
 *
 * @returns {Promise<object|null>} created ClearedCart doc or null when skipped
 */
async function snapshotClearedCart({
  session,
  owner,            // user-like: { telegramId, firstName, lastName, cartState }
  clearedBy = '',
  clearedByName = '',
  reason = '',
  shopId = '',
  shopName = '',
}) {
  const items = cartItemsToObject(owner?.cartState?.orderItems);
  if (countItems(items) <= 0) return null;

  const [doc] = await ClearedCart.create([{
    ownerTelegramId: String(owner.telegramId),
    ownerName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
    orderItems: items,
    orderItemIds: Array.isArray(owner.cartState?.orderItemIds)
      ? owner.cartState.orderItemIds
      : [],
    lastOrderPositions: owner.cartState?.lastOrderPositions || 0,
    clearedBy: String(clearedBy || ''),
    clearedByName: clearedByName || '',
    reason: reason || '',
    shopId: shopId ? String(shopId) : '',
    shopName: shopName || '',
  }], { session });

  return doc;
}

module.exports = { snapshotClearedCart, cartItemsToObject, countItems };
