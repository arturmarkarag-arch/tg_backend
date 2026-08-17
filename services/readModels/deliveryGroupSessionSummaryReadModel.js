'use strict';

/**
 * Admin session-summary projection. Read-only and explicitly session-scoped.
 */
const Order = require('../../models/Order');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../../utils/orderingSchedule');
const { findCurrentSessionId } = require('../../utils/getOrCreateSession');
const { deliveryDaySort, getAllDeliveryGroupsReadOnly } = require('./deliveryGroupCatalogReadModel');

async function buildOneDeliveryGroupSessionSummary(group, ordersByGroup) {
  const normalizedGroup = normalizeDeliveryGroup(group);
  const status = isOrderingOpen(normalizedGroup.orderingSchedule);
  const currentSessionId = await findCurrentSessionId(
    String(normalizedGroup._id),
    normalizedGroup.orderingSchedule,
  );
  const sessionOpenAt = getOrderingWindowOpenAt(normalizedGroup.orderingSchedule);
  const orders = ordersByGroup[String(group._id)] || [];
  const counts = orders.reduce((acc, order) => {
    if (String(order.orderingSessionId || '') === String(currentSessionId || '')) acc.activeCount += 1;
    else acc.staleCount += 1;
    return acc;
  }, { activeCount: 0, staleCount: 0 });

  return {
    groupId: String(normalizedGroup._id),
    groupName: normalizedGroup.name,
    dayOfWeek: normalizedGroup.dayOfWeek,
    isOpen: status.isOpen,
    statusMessage: status.message,
    sessionOpenAt: sessionOpenAt.toISOString(),
    currentSessionId,
    activeCount: counts.activeCount,
    staleCount: counts.staleCount,
  };
}

async function buildDeliveryGroupSessionSummariesReadModel() {
  const groups = await getAllDeliveryGroupsReadOnly();
  const groupIds = groups.map((group) => String(group._id));
  const orders = groupIds.length ? await Order.find({
    'buyerSnapshot.deliveryGroupId': { $in: groupIds },
    status: { $in: ['new', 'in_progress'] },
  }).select('buyerSnapshot.deliveryGroupId orderingSessionId').lean() : [];

  const ordersByGroup = {};
  for (const order of orders) {
    const groupId = String(order?.buyerSnapshot?.deliveryGroupId || '');
    if (!groupId) continue;
    if (!ordersByGroup[groupId]) ordersByGroup[groupId] = [];
    ordersByGroup[groupId].push(order);
  }

  const summaries = await Promise.all(
    groups.map((group) => buildOneDeliveryGroupSessionSummary(group, ordersByGroup)),
  );
  summaries.sort(deliveryDaySort);
  return summaries;
}

module.exports = {
  buildDeliveryGroupSessionSummariesReadModel,
  buildOneDeliveryGroupSessionSummary,
};
