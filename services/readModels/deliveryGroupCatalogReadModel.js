'use strict';

/**
 * Read models for the delivery-group catalogue/selector.
 *
 * These projections are operational summaries only. They never create a session
 * and never treat stale active Orders as proof of the current session phase.
 */
const DeliveryGroup = require('../../models/DeliveryGroup');
const Shop = require('../../models/Shop');
const User = require('../../models/User');
const Order = require('../../models/Order');
const cache = require('../../utils/cache');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { isOrderingOpen, getNextOrderingWindowOpenAt } = require('../../utils/orderingSchedule');
const { PHASE_VOCAB } = require('../../utils/sessionVocab');
const { getCurrentGroupPresentation } = require('../sessionPresentation');

function deliveryDaySort(a, b) {
  const aDay = Number(a?.dayOfWeek) === 0 ? 7 : Number(a?.dayOfWeek);
  const bDay = Number(b?.dayOfWeek) === 0 ? 7 : Number(b?.dayOfWeek);
  if (aDay !== bDay) return aDay - bDay;
  return String(a?.name || a?.groupName || '').localeCompare(String(b?.name || b?.groupName || ''));
}

async function getAllDeliveryGroupsReadOnly() {
  let groups = await cache.get(cache.KEYS.DELIVERY_GROUPS);
  if (!groups) {
    groups = await DeliveryGroup.find().lean();
    await cache.set(cache.KEYS.DELIVERY_GROUPS, groups);
  }
  return groups;
}

async function loadShopAndSellerCounts() {
  const [shopCounts, sellerCounts] = await Promise.all([
    Shop.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
    ]),
    // Compatibility metric: this field is literally "sellerCount" in the UI,
    // so it remains seller-role count. CURRENT assignment eligibility (seller +
    // admin) lives in shopOperationalState/currentAssignment and is not inferred
    // from this display metric.
    User.aggregate([
      { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
      { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
      { $unwind: '$shop' },
      { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    shopCountMap: Object.fromEntries(shopCounts.map(({ _id, count }) => [String(_id), count])),
    sellerCountMap: Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count])),
  };
}

async function buildDeliveryGroupSummaryReadModel() {
  const [groups, counts] = await Promise.all([
    getAllDeliveryGroupsReadOnly(),
    loadShopAndSellerCounts(),
  ]);
  const result = groups.map(normalizeDeliveryGroup).map((group) => ({
    _id: group._id,
    name: group.name,
    dayOfWeek: group.dayOfWeek,
    shopCount: counts.shopCountMap[String(group._id)] || 0,
    sellerCount: counts.sellerCountMap[String(group._id)] || 0,
  }));
  result.sort(deliveryDaySort);
  return result;
}

async function buildDeliveryGroupListReadModel({ now = new Date() } = {}) {
  const groups = (await getAllDeliveryGroupsReadOnly()).map(normalizeDeliveryGroup);
  groups.sort(deliveryDaySort);

  const closedGroupIds = groups
    .filter((group) => !isOrderingOpen(group.orderingSchedule, now).isOpen)
    .map((group) => String(group._id));

  const [counts, ordersInClosedGroups, presentations] = await Promise.all([
    loadShopAndSellerCounts(),
    closedGroupIds.length ? Order.find({
      'buyerSnapshot.deliveryGroupId': { $in: closedGroupIds },
      status: { $in: ['new', 'in_progress'] },
    }).select('buyerSnapshot.deliveryGroupId').lean() : [],
    Promise.all(groups.map((group) => getCurrentGroupPresentation(group, { now }))),
  ]);

  const problematicByGroup = {};
  for (const order of ordersInClosedGroups) {
    const groupId = order?.buyerSnapshot?.deliveryGroupId
      ? String(order.buyerSnapshot.deliveryGroupId)
      : '';
    if (groupId) problematicByGroup[groupId] = true;
  }

  return groups.map((group, index) => ({
    ...group,
    isOpen: isOrderingOpen(group.orderingSchedule, now).isOpen,
    shopCount: counts.shopCountMap[String(group._id)] || 0,
    sellerCount: counts.sellerCountMap[String(group._id)] || 0,
    // Compatibility/debug only: stale active orders are not session phase.
    hasRelocatedOrders: Boolean(problematicByGroup[String(group._id)]),
    pickingStatus: presentations[index]?.pickingStatus ?? null,
    phase: presentations[index]?.phase ?? null,
    phaseLabel: presentations[index]?.phase
      ? (PHASE_VOCAB[presentations[index].phase]?.label || presentations[index].phase)
      : null,
    presentationMode: presentations[index]?.presentationMode ?? presentations[index]?.phase ?? 'idle',
    nextOrderingOpenAt: presentations[index]?.nextOrderingOpenAt
      ?? getNextOrderingWindowOpenAt(group.orderingSchedule, now).toISOString(),
  }));
}

module.exports = {
  buildDeliveryGroupListReadModel,
  buildDeliveryGroupSummaryReadModel,
  deliveryDaySort,
  getAllDeliveryGroupsReadOnly,
  loadShopAndSellerCounts,
};
