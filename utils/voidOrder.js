'use strict';

/**
 * Terminate every still-open position of an order that is being voided wholesale
 * (Order.status → 'expired').
 *
 * Every path that expires an order must call this. Setting the order status alone
 * leaves the positions in a permanent "ordered, never processed" limbo: `expired`
 * is intentionally outside the delivery cycle, so the coverage and closure audits
 * skip such orders entirely (services/sessionCoverage.js, services/sessionClosure.js)
 * and no invariant check ever revisits those rows.
 *
 * Already-terminal rows are left untouched: if a position really was packed before
 * the order got voided, that record is the truth and must survive.
 *
 * @param {object} order  a loaded Order document (or plain object with `items`)
 * @returns {number} how many positions were newly marked
 */
function voidOpenOrderItems(order) {
  let voidedCount = 0;
  for (const item of order?.items || []) {
    if (item.packed || item.cancelled || item.skipped || item.voided) continue;
    item.voided = true;
    voidedCount += 1;
  }
  return voidedCount;
}

/**
 * Same rule for bulk `updateMany` paths, which never load documents.
 *
 *   Order.updateMany(
 *     filter,
 *     { $set: { status: 'expired', 'items.$[open].voided': true } },
 *     { session, arrayFilters: [OPEN_ITEM_ARRAY_FILTER] },
 *   )
 *
 * The `$ne: true` form (not `false`) also matches rows written before these flags
 * existed, where the field is simply absent.
 */
const OPEN_ITEM_ARRAY_FILTER = {
  'open.packed': { $ne: true },
  'open.cancelled': { $ne: true },
  'open.skipped': { $ne: true },
};

module.exports = { voidOpenOrderItems, OPEN_ITEM_ARRAY_FILTER };
