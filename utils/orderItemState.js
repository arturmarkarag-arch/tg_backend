'use strict';

// Canonical OrderItem terminal-state vocabulary. Keep this small utility free of
// model imports so every route/service can share the exact same semantics.
function isTerminalOrderItem(item) {
  return Boolean(item?.packed || item?.cancelled || item?.skipped || item?.voided);
}

function isLiveOrderItem(item) {
  return !isTerminalOrderItem(item);
}

/**
 * Expiring an Order removes it from the delivery cycle, but its still-open lines
 * must retain an explicit terminal outcome for history/analytics. This is NOT
 * `cancelled`: cancelled means warehouse/OOS and is shown to the seller as
 * «Закінчився». `voided` means the whole order left this cycle.
 */
function voidOpenOrderItems(order, { reason = 'order_expired', at = new Date() } = {}) {
  if (!order || !Array.isArray(order.items)) return 0;
  let changed = 0;
  for (const item of order.items) {
    if (isTerminalOrderItem(item)) continue;
    item.voided = true;
    item.voidReason = reason;
    item.voidedAt = at;
    changed += 1;
  }
  return changed;
}

function openItemArrayFilter(alias = 'open') {
  return {
    [`${alias}.packed`]: { $ne: true },
    [`${alias}.cancelled`]: { $ne: true },
    [`${alias}.skipped`]: { $ne: true },
    [`${alias}.voided`]: { $ne: true },
  };
}

module.exports = {
  isTerminalOrderItem,
  isLiveOrderItem,
  voidOpenOrderItems,
  openItemArrayFilter,
};
