/**
 * Multi-worker receipt item rules.
 *
 * Ownership model:
 *   - The worker who added an item (item.createdBy) — plus any admin — may edit
 *     owner-only receiving fields and delete/confirm it.
 *   - Any other warehouse/admin user may edit ONLY the shared shop-facing fields
 *     (price, qtyPerPackage).
 *
 * `totalQty` is the single received-quantity source of truth.
 */

const { appError } = require('./errors');

const OWNER_ONLY_FIELDS = new Set([
  'totalQty', 'destination', 'deliveryGroupIds', 'qtyPerShop',
]);

const SHARED_FIELDS = new Set(['price', 'qtyPerPackage']);

function isOwnerOrAdmin(user, item) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!item.createdBy && String(item.createdBy) === String(user.telegramId);
}

function assertCanEditItem(user, item, changedFields) {
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

/**
 * Confirmation completeness: photo + total received qty + price + package qty.
 */
function assertItemReadyToConfirm(item) {
  const missing = [];
  if (!item.photoUrl) missing.push('фото');
  if (!(item.totalQty >= 1)) missing.push('кількість що приїхала');
  if (item.price == null || !(item.price > 0)) missing.push('ціна');
  if (!(item.qtyPerPackage >= 1)) missing.push('кількість в упаковці');
  if (missing.length > 0) {
    throw appError('receipt_item_incomplete', { fields: missing.join(', ') });
  }
}

module.exports = {
  OWNER_ONLY_FIELDS,
  SHARED_FIELDS,
  isOwnerOrAdmin,
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  assertItemReadyToConfirm,
};
