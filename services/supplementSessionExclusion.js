'use strict';

const SupplementOffer = require('../models/SupplementOffer');
const { appError } = require('../utils/errors');

function str(value) {
  return value == null ? '' : String(value);
}

function exclusionFilter(orderingSessionId, extra = {}) {
  return {
    orderingSessionId: str(orderingSessionId),
    waveId: { $ne: null },
    itemStatus: 'active',
    productId: { $ne: null },
    ...extra,
  };
}

/**
 * A warehouse Product published as a supplement item for OrderingSession X may
 * not simultaneously participate in ordinary ordering for that SAME session.
 *
 * The relation is session-scoped. It is not a permanent Product flag:
 * - later OrderingSessions may order the warehouse Product normally;
 * - a compensating route correction withdraws the Wave item (`itemStatus=withdrawn`)
 *   and therefore removes the exclusion.
 */
async function getSupplementExcludedProductIds(orderingSessionId, { session = null } = {}) {
  if (!orderingSessionId) return [];
  let query = SupplementOffer.distinct('productId', exclusionFilter(orderingSessionId));
  if (session) query = query.session(session);
  return query;
}

async function isProductSupplementExcluded(productId, orderingSessionId, { session = null } = {}) {
  if (!productId || !orderingSessionId) return false;
  let query = SupplementOffer.exists(exclusionFilter(orderingSessionId, { productId }));
  if (session) query = query.session(session);
  return Boolean(await query);
}

async function assertProductOrdinaryOrderable(productId, orderingSessionId, { session = null } = {}) {
  if (await isProductSupplementExcluded(productId, orderingSessionId, { session })) {
    throw appError('product_supplement_session_only');
  }
}

module.exports = {
  getSupplementExcludedProductIds,
  isProductSupplementExcluded,
  assertProductOrdinaryOrderable,
};
