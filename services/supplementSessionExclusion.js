'use strict';

const SupplementOffer = require('../models/SupplementOffer');
const { appError } = require('../utils/errors');
const { ITEM_STATUS, ITEM_RELATION_STATUS } = require('../utils/supplementState');

function str(value) {
  return value == null ? '' : String(value);
}

function exclusionFilter(orderingSessionId, extra = {}) {
  return {
    orderingSessionId: str(orderingSessionId),
    waveId: { $ne: null },
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    productId: { $ne: null },
    $or: [
      { status: { $in: [ITEM_STATUS.OPEN, ITEM_STATUS.FROZEN, ITEM_STATUS.COMPLETED] } },
      {
        status: ITEM_STATUS.CANCELLED,
        $or: [
          { frozenAt: { $type: 'date' } },
          { completedAt: { $type: 'date' } },
          { revisionHistory: { $elemMatch: { status: { $in: [ITEM_STATUS.FROZEN, ITEM_STATUS.COMPLETED] } } } },
          { revisionHistory: { $elemMatch: { frozenAt: { $type: 'date' } } } },
          { revisionHistory: { $elemMatch: { completedAt: { $type: 'date' } } } },
        ],
      },
    ],
    ...extra,
  };
}

/**
 * A warehouse Product published as a supplement item for OrderingSession X may
 * not simultaneously participate in ordinary ordering for that SAME session.
 *
 * The relation is session-scoped. It is not a permanent Product flag:
 * - later OrderingSessions may order the warehouse Product normally;
 * - OPEN cancellation as a target correction removes the exact-session exclusion;
 * - FROZEN/COMPLETED work remains excluded for that same exact session;
 * - a compensating route correction additionally withdraws the item relation.
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
