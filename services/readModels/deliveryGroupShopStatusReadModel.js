'use strict';

/**
 * Facade for the two operational shop-status projections.
 *
 * view=readiness -> CURRENT topology only
 * view=current   -> CURRENT topology + current session + history display
 *
 * The facade is read-only. It deliberately uses find/read builders only and is
 * safe to call from GET handlers or polling.
 */
const DeliveryGroup = require('../../models/DeliveryGroup');
const { appError } = require('../../utils/errors');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { isOrderingOpen } = require('../../utils/orderingSchedule');
const { buildCurrentShopTopologyReadModel } = require('./currentShopTopologyReadModel');
const { buildCurrentSessionShopStatusReadModel } = require('./currentSessionShopStatusReadModel');

const SHOP_STATUS_VIEWS = Object.freeze({
  CURRENT: 'current',
  READINESS: 'readiness',
});

function normalizeShopStatusView(value) {
  return value === SHOP_STATUS_VIEWS.READINESS
    ? SHOP_STATUS_VIEWS.READINESS
    : SHOP_STATUS_VIEWS.CURRENT;
}

async function buildDeliveryGroupShopStatusReadModel({ groupId, view = 'current', viewerRole = '' }) {
  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(groupId).lean());
  if (!group) throw appError('group_not_found');
  const normalizedView = normalizeShopStatusView(view);
  const status = isOrderingOpen(group.orderingSchedule);

  if (normalizedView === SHOP_STATUS_VIEWS.READINESS) {
    const shops = await buildCurrentShopTopologyReadModel(group);
    return {
      groupId: String(group._id),
      groupName: group.name,
      isOpen: status.isOpen,
      view: SHOP_STATUS_VIEWS.READINESS,
      currentSessionId: null,
      viewerRole,
      staleOrderCount: 0,
      staleOrders: [],
      shops,
    };
  }

  const current = await buildCurrentSessionShopStatusReadModel(group, { windowOpen: status.isOpen });
  return {
    groupId: String(group._id),
    groupName: group.name,
    isOpen: status.isOpen,
    currentSessionId: current.currentSessionId,
    view: SHOP_STATUS_VIEWS.CURRENT,
    viewerRole,
    staleOrderCount: current.staleOrders.length,
    staleOrders: current.staleOrders,
    shops: current.shops,
  };
}

module.exports = {
  SHOP_STATUS_VIEWS,
  normalizeShopStatusView,
  buildDeliveryGroupShopStatusReadModel,
};
