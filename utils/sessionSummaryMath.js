'use strict';

const {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isOperationalOrderStatus,
} = require('./orderStatus');
const ARCHIVE_REASONS = new Set(['out_of_stock', 'system_archive']);

function summarizeSessionRows({ tasks = [], orders = [], archivedProductIds = [] } = {}) {
  const archivedIds = new Set((archivedProductIds || []).map((x) => String(x)));
  const operationalOrders = orders.filter((o) => o && isOperationalOrderStatus(o.status));
  const totalOrderCount = operationalOrders.length;
  const completedOrderCount = operationalOrders.filter((o) => TERMINAL_ORDER_STATUSES.includes(o.status)).length;

  const totalProductCount = tasks.length;
  const processedProductCount = tasks.filter((t) => t?.status === 'completed').length;

  const archiveRequired = tasks.filter(
    (t) => t?.status === 'completed' && ARCHIVE_REASONS.has(String(t?.completionReason || '')),
  );
  const archiveRequiredProductCount = archiveRequired.length;
  const archivedProductCount = archiveRequired.filter((t) => {
    if (t.completionReason === 'system_archive') return true;
    return t.completionReason === 'out_of_stock' && (
      t.archiveReconciled === true || archivedIds.has(String(t.productId || ''))
    );
  }).length;

  return {
    processedProductCount,
    totalProductCount,
    archivedProductCount,
    archiveRequiredProductCount,
    completedOrderCount,
    totalOrderCount,
  };
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  summarizeSessionRows,
};
