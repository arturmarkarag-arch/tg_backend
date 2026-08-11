'use strict';

/**
 * Order ownership lifecycle.
 *
 * buyerTelegramId is AUTHOR provenance.
 * shopId + buyerSnapshot + orderingSessionId describe which SHOP/session owns
 * the order operationally.
 *
 * While the ordering window is still open (and picking is pending), a normal
 * seller reassignment may carry that seller's active Order to another shop.
 * Once the ordering window closes OR picking has started, the Order is frozen
 * to the shop/session. Moving/unassigning the User must not rewrite historical
 * order ownership. Dedicated conflict-repair code may explicitly opt out of the
 * guard because that is an intentional Order repair, not an implicit side effect
 * of changing User.shopId.
 */
function isOwnershipFrozenFromSession(sessionDoc, now = new Date()) {
  if (!sessionDoc) return false;
  if (sessionDoc.pickingStatus && sessionDoc.pickingStatus !== 'pending') return true;
  // Missing closeAt is legacy/unknown state. Fail closed: never let an ordinary
  // profile move rewrite Order ownership when we cannot prove ordering is open.
  if (!sessionDoc.closeAt) return true;
  const closeMs = new Date(sessionDoc.closeAt).getTime();
  return Number.isFinite(closeMs) && closeMs <= now.getTime();
}

async function getOrderOwnershipState(order, { session = null, now = new Date() } = {}) {
  const orderingSessionId = order?.orderingSessionId ? String(order.orderingSessionId) : '';
  if (!orderingSessionId) return { frozen: false, reason: 'no_ordering_session', session: null };

  const OrderingSession = require('../models/OrderingSession');
  let query = OrderingSession.findById(orderingSessionId, '_id closeAt pickingStatus openDate');
  if (session) query = query.session(session);
  const sessionDoc = await query.lean();
  // A non-empty historical session id whose document is missing is unsafe to
  // mutate implicitly. Freeze it and require explicit repair instead of making
  // an old Order follow the seller into today's shop.
  if (!sessionDoc) return { frozen: true, reason: 'session_not_found', session: null };

  if (sessionDoc.pickingStatus && sessionDoc.pickingStatus !== 'pending') {
    return { frozen: true, reason: 'picking_started', session: sessionDoc };
  }
  if (!sessionDoc.closeAt) {
    return { frozen: true, reason: 'missing_close_at', session: sessionDoc };
  }
  const closeMs = new Date(sessionDoc.closeAt).getTime();
  if (!Number.isFinite(closeMs) || closeMs <= now.getTime()) {
    return { frozen: true, reason: Number.isFinite(closeMs) ? 'ordering_closed' : 'invalid_close_at', session: sessionDoc };
  }
  return { frozen: false, reason: 'ordering_open', session: sessionDoc };
}

module.exports = { isOwnershipFrozenFromSession, getOrderOwnershipState };
