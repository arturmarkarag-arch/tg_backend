'use strict';

const mongoose = require('mongoose');

const ACTIVE_ORDER_STATUSES = ['new', 'in_progress'];

/**
 * Build a Mongo filter for an active order that belongs to a shop, matched by
 * BOTH the top-level `shopId` AND `buyerSnapshot.shopId`.
 *
 * Why: orders created via the direct add-to-order path historically have a null
 * top-level `shopId` with the real shop living only in `buyerSnapshot.shopId`.
 * Querying the top-level field alone silently skips those orders (the root cause
 * of the "0 orders on pre-start vs N tasks built" desync, plus missed
 * parking/transfer/conflict detection).
 *
 * `buyerSnapshot.shopId` is stored as an ObjectId in some paths and as a String
 * in others, so we match every form.
 *
 * Single source of truth — replace the scattered `$or: [{shopId}, ...]`
 * copy-paste with one call. Once every order reliably carries a top-level
 * shopId, the snapshot branches can be dropped here in one place.
 *
 * @param {string|import('mongoose').Types.ObjectId} shopId
 * @param {object} [extra]  merged into the filter (e.g. { buyerTelegramId }).
 *                          Can override `status` by providing its own.
 * @returns {object} Mongo filter
 */
function activeOrderShopFilter(shopId, extra = {}) {
  const str = String(shopId);
  const oid = mongoose.isValidObjectId(shopId) ? new mongoose.Types.ObjectId(str) : null;

  const or = oid
    ? [{ shopId: oid }, { 'buyerSnapshot.shopId': oid }, { 'buyerSnapshot.shopId': str }]
    : [{ shopId: str }, { 'buyerSnapshot.shopId': str }];

  return {
    status: { $in: ACTIVE_ORDER_STATUSES },
    ...extra,
    $or: or,
  };
}

module.exports = { activeOrderShopFilter, ACTIVE_ORDER_STATUSES };
