'use strict';

/**
 * Order status recomputation after some of its items were cancelled/skipped.
 *
 * Shared by every path that removes an item from a live order (product archive,
 * coverage-gap resolution) so the rules exist exactly once.
 *
 * While the ordering window is OPEN the status is frozen: the seller may still be
 * editing the cart, and flipping them to `confirmed`/`cancelled` mid-edit would
 * lock them out of their own order.
 *
 * @param {object} order            Order document (items already mutated)
 * @param {boolean} orderingOpenNow Is the buyer's delivery-group window open?
 * @returns {string} the status the order should now carry
 */
function resolveOrderStatusAfterCancel(order, orderingOpenNow) {
  if (orderingOpenNow) return order.status;

  const isFullyProcessed = order.items.every((i) => i.packed || i.cancelled || i.skipped);
  if (!isFullyProcessed) return 'in_progress';

  // "Nothing delivered" = every item is cancelled or skipped (none packed).
  const allUndelivered = order.items.every((i) => i.cancelled || i.skipped);
  return allUndelivered ? 'cancelled' : 'confirmed';
}

module.exports = { resolveOrderStatusAfterCancel };
