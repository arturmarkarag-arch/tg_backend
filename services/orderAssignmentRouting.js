'use strict';

const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const { appError } = require('../utils/errors');
const { getOrCreateSessionId, getOrCreateNextSessionId } = require('../utils/getOrCreateSession');
const { isOrderingOpen } = require('../utils/orderingSchedule');

/**
 * Resolve WHERE a mutable Order should go after an assignment/repair change.
 *
 * This is deliberately separate from source Order discovery. CURRENT/NEXT is a
 * destination-routing decision only; it never determines whether the seller's
 * source Order "exists" for migration.
 *
 * Destination acceptance is stricter than source ownership discovery. CURRENT
 * accepts a transferred Order only while ordering is open AND picking is still
 * pending. Once the target window closes, route to NEXT so the transfer cannot
 * create an immediately-frozen Order in a shop the seller is about to leave.
 */
async function resolveAssignmentDestination({
  shop,
  session = null,
  now = new Date(),
} = {}) {
  const deliveryGroupId = shop?.deliveryGroupId ? String(shop.deliveryGroupId) : '';
  if (!deliveryGroupId) {
    return {
      deliveryGroupId: null,
      currentSessionId: null,
      targetSessionId: null,
      routedToNextSession: false,
      routeReason: 'no_delivery_group',
    };
  }

  let groupQuery = DeliveryGroup.findById(deliveryGroupId);
  if (session) groupQuery = groupQuery.session(session);
  const group = await groupQuery.lean();
  if (!group) throw appError('group_not_found');

  const sessionOptions = session ? { session } : {};
  const currentSessionId = await getOrCreateSessionId(
    deliveryGroupId,
    group.orderingSchedule,
    sessionOptions,
  );
  // A Shop with a delivery group must never receive an Order while its target
  // session identity is unknown. Keeping the source session id would create a
  // cross-group Order that looks assigned correctly by shopId but belongs to the
  // wrong weekly cycle.
  if (!currentSessionId) throw appError('ordering_session_not_found');

  let currentQuery = OrderingSession.findById(currentSessionId, '_id pickingStatus openDate');
  if (session) currentQuery = currentQuery.session(session);
  const currentSession = await currentQuery.lean();
  if (!currentSession) throw appError('ordering_session_not_found');

  const orderingOpen = isOrderingOpen(group.orderingSchedule, now).isOpen;
  if (orderingOpen && currentSession.pickingStatus === 'pending') {
    return {
      deliveryGroupId,
      currentSessionId,
      targetSessionId: currentSessionId,
      routedToNextSession: false,
      routeReason: 'current_picking_pending',
    };
  }

  const targetSessionId = await getOrCreateNextSessionId(
    deliveryGroupId,
    group.orderingSchedule,
    sessionOptions,
  );
  if (!targetSessionId) throw appError('ordering_session_not_found');

  return {
    deliveryGroupId,
    currentSessionId,
    targetSessionId,
    routedToNextSession: true,
    routeReason: orderingOpen ? 'current_picking_started' : 'current_ordering_closed',
  };
}

module.exports = { resolveAssignmentDestination };
