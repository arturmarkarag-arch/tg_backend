'use strict';

/**
 * One-shot/idempotent compatibility migration for rows created by the old
 * unassignSellerAndPark() representation.
 *
 * Old representation:
 *   status = new|in_progress
 *   orderingSessionId is preserved
 *   shopId = null
 *   buyerSnapshot.shopId = null/missing
 *   buyerSnapshot.deliveryGroupId = ''/null/missing
 *
 * New representation keeps ownership intact and parks by status only. We cannot
 * reconstruct erased ownership here, so this migration only reclassifies the
 * known legacy parked shape as non-operational `new_unassign`. It never guesses
 * a shop/group and never moves the Order to another session.
 */
const Order = require('../models/Order');
const { ORDER_STATUS, ACTIVE_ORDER_STATUSES } = require('../utils/orderStatus');

async function migrateLegacyParkedOrders() {
  const at = new Date();
  const result = await Order.updateMany(
    {
      status: { $in: ACTIVE_ORDER_STATUSES },
      orderingSessionId: { $gt: '' },
      shopId: null,
      $and: [
        {
          $or: [
            { 'buyerSnapshot.shopId': null },
            { 'buyerSnapshot.shopId': { $exists: false } },
          ],
        },
        {
          $or: [
            { 'buyerSnapshot.deliveryGroupId': '' },
            { 'buyerSnapshot.deliveryGroupId': null },
            { 'buyerSnapshot.deliveryGroupId': { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: { status: ORDER_STATUS.NEW_UNASSIGN },
      $push: {
        history: {
          at,
          by: 'system',
          byName: 'system',
          byRole: 'system',
          action: 'legacy_parked_order_status_migrated',
          meta: { toStatus: ORDER_STATUS.NEW_UNASSIGN },
        },
      },
    },
  );

  return {
    matched: Number(result?.matchedCount || 0),
    modified: Number(result?.modifiedCount || 0),
  };
}

module.exports = { migrateLegacyParkedOrders };
