/**
 * Multi-worker receipt item rules.
 *
 * Ownership model:
 *   - The worker who added an item (item.createdBy) — plus any admin — may edit
 *     EVERYTHING and delete/confirm it.
 *   - Any other warehouse/admin user may edit ONLY the shared shop-facing fields
 *     (price, qtyPerPackage). They cannot touch quantity / structure /
 *     destination / delivery groups, and cannot delete the item.
 *   - A 'confirmed' item is frozen: nobody but an admin may edit or delete it.
 *     To change it the owner must (currently) ask an admin — there is no
 *     un-confirm endpoint in v1 by design ("підписав = готово").
 *
 * The route layer passes the set of fields a request actually changes; we only
 * reject when a *restricted* field is among them, so re-submitting unchanged
 * values from the UI never trips a false 403.
 */

const { appError } = require('./errors');

// Only the item owner (or admin) may change these.
// NOTE: photo fields are intentionally NOT here — the annotated photo is a
// derivative of price/qty (which anyone may edit), so a non-owner price change
// must be allowed to re-upload the regenerated overlay.
const OWNER_ONLY_FIELDS = new Set([
  'totalQty', 'shelfQty', 'transitQty', 'destination', 'structure',
  'deliveryGroupIds', 'qtyPerShop', 'barcode',
  'existingProductId', 'warehousePending',
]);

// Shop-facing data — any warehouse/admin user may fill these on any item.
const SHARED_FIELDS = new Set(['price', 'qtyPerPackage']);

function isOwnerOrAdmin(user, item) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!item.createdBy && String(item.createdBy) === String(user.telegramId);
}

/**
 * @param {object}   user          req.user (telegramId, role)
 * @param {object}   item          ReceiptItem document
 * @param {string[]} changedFields field names this request actually mutates
 */
function assertCanEditItem(user, item, changedFields) {
  const isAdmin = user && user.role === 'admin';

  if (item.status === 'confirmed' && !isAdmin) {
    throw appError('receipt_item_already_confirmed');
  }
  if (isOwnerOrAdmin(user, item)) return;

  const restricted = (changedFields || []).filter((f) => OWNER_ONLY_FIELDS.has(f));
  if (restricted.length > 0) {
    throw appError('receipt_item_forbidden_edit', { owner: item.createdBy || '' });
  }
}

function assertCanDeleteItem(user, item) {
  const isAdmin = user && user.role === 'admin';
  if (item.status === 'confirmed' && !isAdmin) {
    throw appError('receipt_item_already_confirmed');
  }
  if (!isOwnerOrAdmin(user, item)) {
    throw appError('receipt_item_forbidden_delete');
  }
}

function assertCanConfirmItem(user, item) {
  if (!isOwnerOrAdmin(user, item)) {
    throw appError('receipt_item_forbidden_confirm');
  }
}

function isPosInt(n) {
  return Number.isInteger(n) && n >= 1;
}

/**
 * Validate a structure object and compute the implied total quantity.
 * Returns { totalQty, structure } where structure is normalized, or throws
 * receipt_structure_invalid. For type 'direct' the caller supplies the manual
 * totalQty (we don't compute it here).
 *
 * @param {object|null} raw            parsed structure object (or null/undefined)
 * @param {number}      manualTotalQty fallback totalQty for type 'direct'
 */
function resolveStructure(raw, manualTotalQty) {
  const type = raw && raw.type ? String(raw.type) : 'direct';

  if (type === 'direct') {
    if (!isPosInt(manualTotalQty)) throw appError('receipt_qty_invalid');
    return { totalQty: manualTotalQty, structure: { type: 'direct' } };
  }

  if (type === 'pallets_boxes_items') {
    const pallets = Math.trunc(Number(raw.pallets));
    const boxesPerPallet = Math.trunc(Number(raw.boxesPerPallet));
    const itemsPerBox = Math.trunc(Number(raw.itemsPerBox));
    if (![pallets, boxesPerPallet, itemsPerBox].every(isPosInt)) {
      throw appError('receipt_structure_invalid');
    }
    return {
      totalQty: pallets * boxesPerPallet * itemsPerBox,
      structure: { type, pallets, boxesPerPallet, itemsPerBox },
    };
  }

  if (type === 'pallets_items') {
    const pallets = Math.trunc(Number(raw.pallets));
    const itemsPerPallet = Math.trunc(Number(raw.itemsPerPallet));
    if (![pallets, itemsPerPallet].every(isPosInt)) {
      throw appError('receipt_structure_invalid');
    }
    return {
      totalQty: pallets * itemsPerPallet,
      structure: { type, pallets, itemsPerPallet },
    };
  }

  throw appError('receipt_structure_invalid');
}

/**
 * Map the UI-level destination onto the existing shelfQty/transitQty split so
 * the (unchanged) commit logic keeps working.
 *   'shelf' → everything to warehouse incoming strip
 *   'shops' → everything to transit allocation (delivery groups required)
 */
function deriveSplit(destination, totalQty) {
  if (destination === 'shops') return { shelfQty: 0, transitQty: totalQty };
  return { shelfQty: totalQty, transitQty: 0 };
}

module.exports = {
  OWNER_ONLY_FIELDS,
  SHARED_FIELDS,
  isOwnerOrAdmin,
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  resolveStructure,
  deriveSplit,
};
