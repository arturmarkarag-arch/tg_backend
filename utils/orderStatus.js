'use strict';

const { isTerminalOrderItem, liveOrderItemMongoMatch } = require('./orderItemState');

/**
 * Canonical Order status vocabulary.
 *
 * `new_unassign` is a parked order created by a seller who is temporarily not
 * assigned to a shop. The Order keeps its shop/group/session ownership for
 * provenance and deterministic restoration, but it is NOT operational work:
 * it must not enter picking, active-order blockers, or session completion.
 * When that seller is assigned again while ownership is still mutable, the
 * canonical assignment command moves the Order to the target shop/session and
 * restores the status to `new`.
 */
const ORDER_STATUS = Object.freeze({
  NEW: 'new',
  NEW_UNASSIGN: 'new_unassign',
  IN_PROGRESS: 'in_progress',
  CONFIRMED: 'confirmed',
  FULFILLED: 'fulfilled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

const ORDER_STATUS_VALUES = Object.freeze(Object.values(ORDER_STATUS));
const ACTIVE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.NEW,
  ORDER_STATUS.IN_PROGRESS,
]);
const PARKED_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.NEW_UNASSIGN,
]);
const TERMINAL_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.FULFILLED,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.CANCELLED,
]);


/**
 * Order status recomputation after some of its items were cancelled/skipped/voided.
 *
 * Shared by every path that removes an item from a live order (product archive,
 * coverage-gap resolution) so the rules exist exactly once.
 *
 * While the ordering window is OPEN the status is frozen: the seller may still be
 * editing the cart, and flipping them to `confirmed`/`cancelled` mid-edit would
 * lock them out of their own order.
 */
function resolveOrderStatusAfterCancel(order, orderingOpenNow) {
  if (orderingOpenNow) return order.status;

  const isFullyProcessed = order.items.every(isTerminalOrderItem);
  if (!isFullyProcessed) return ORDER_STATUS.IN_PROGRESS;

  const allUndelivered = order.items.every((i) => i.cancelled || i.skipped || i.voided);
  return allUndelivered ? ORDER_STATUS.CANCELLED : ORDER_STATUS.CONFIRMED;
}


/**
 * Canonical predicate for an Order that still carries ordinary warehouse work.
 * Status alone is insufficient: while ordering is open, archive/OOS cancellation
 * intentionally leaves Order.status='new' so the seller may keep editing. Such a
 * status-only shell must not create picking conflicts or tasks.
 */
function hasLiveOrderItems(order) {
  return Array.isArray(order?.items) && order.items.some((item) => !isTerminalOrderItem(item));
}

function buildLiveActiveOrderFilter(extra = {}) {
  return {
    ...extra,
    status: { $in: ACTIVE_ORDER_STATUSES },
    items: { $elemMatch: liveOrderItemMongoMatch() },
  };
}

function isActiveOrderStatus(status) {
  return ACTIVE_ORDER_STATUSES.includes(String(status || ''));
}

function isParkedOrderStatus(status) {
  return PARKED_ORDER_STATUSES.includes(String(status || ''));
}

function isOperationalOrderStatus(status) {
  const value = String(status || '');
  return value !== ORDER_STATUS.EXPIRED && !isParkedOrderStatus(value);
}

module.exports = {
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  ACTIVE_ORDER_STATUSES,
  PARKED_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  hasLiveOrderItems,
  buildLiveActiveOrderFilter,
  isActiveOrderStatus,
  isParkedOrderStatus,
  isOperationalOrderStatus,
  resolveOrderStatusAfterCancel,
};
