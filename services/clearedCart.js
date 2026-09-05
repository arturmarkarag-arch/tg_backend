'use strict';

function cartItemsToObject(orderItems) {
  if (!orderItems) return {};
  return orderItems instanceof Map ? Object.fromEntries(orderItems) : { ...orderItems };
}

// Historical snapshot readers only. No runtime writer or restore path uses
// User.cartState for quantities; active order data lives in Order.
module.exports = { cartItemsToObject };
