/**
 * Multi-worker receipt item rules.
 *
 * Ownership model:
 *   - The worker who added an item (item.createdBy) — plus any admin — may edit
 *     owner-only receiving fields / routing and delete/confirm it.
 *   - Any other warehouse/admin user may edit ONLY the shared shop-facing fields
 *     (price, qtyPerPackage).
 *
 * `totalQty` is retained as received-quantity reference data. It is NOT used to
 * infer leftovers or automatically choose a route.
 */

const { appError } = require('./errors');
const { normalizeReceiptItemRouting, validateReceiptItemRouting } = require('./receiptRouting');

const OWNER_ONLY_FIELDS = new Set([
  'totalQty', 'originalPhotoUrl', 'destination', 'routing', 'deliveryGroupIds', 'qtyPerShop',
]);

// `photoUrl` may be re-rendered by the shared Stage-2 preparation flow while the
// clean source photo (`originalPhotoUrl`) remains owner/admin-only receiving data.
const SHARED_FIELDS = new Set(['price', 'qtyPerPackage', 'photoUrl', 'photoMeta']);

function isOwnerOrAdmin(user, item) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!item.createdBy && String(item.createdBy) === String(user.telegramId);
}

function assertCanEditItem(user, item, changedFields) {
  if (isOwnerOrAdmin(user, item)) return;

  // A non-owner may participate only in Stage 2 shared commercial preparation.
  // Do not rely on a blacklist here: newly-added receiving/business fields must
  // be denied by default until they are explicitly classified as shared.
  const disallowed = (changedFields || []).filter((f) => !SHARED_FIELDS.has(f));
  if (disallowed.length > 0) {
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

function preparationMissingFields(item) {
  const missing = [];
  if (!item?.photoUrl) missing.push('фото');
  if (!(Number(item?.totalQty) >= 1)) missing.push('кількість що приїхала');
  if (!(Number(item?.price) > 0)) missing.push('ціна');
  if (!(Number(item?.qtyPerPackage) >= 1)) missing.push('кількість в упаковці');
  return missing;
}

/**
 * Stage 2 gate. A product cannot enter routing until receiving + commercial
 * preparation are complete. This is intentionally route-agnostic.
 */
function assertItemReadyForRouting(item) {
  const missing = preparationMissingFields(item);
  if (missing.length > 0) {
    throw appError('receipt_item_not_prepared', { fields: missing.join(', ') });
  }
}

/**
 * Confirmation completeness:
 *   - photo + received qty are receiving requirements;
 *   - price and package quantity may be filled later while the row is draft,
 *     but BOTH are mandatory before confirmation/publication;
 *   - a route must be chosen before confirmation.
 */
function assertItemReadyToConfirm(item, receipt = null) {
  const missing = preparationMissingFields(item);

  // Respect the staged pipeline even for cached/legacy clients: Stage 2 must be
  // complete before route completeness is evaluated. Otherwise an untouched row
  // would misleadingly fail with "choose route" while price/package are still
  // missing and Stage 3 is not allowed yet.
  if (missing.length > 0) {
    throw appError('receipt_item_incomplete', { fields: missing.join(', ') });
  }

  const routing = normalizeReceiptItemRouting(item, receipt);
  const currentBatchSupplement = receipt?.type !== 'supplement'
    && Number(item?.routingVersion || 0) >= 1
    && routing.supplement;
  const routeCheck = validateReceiptItemRouting(routing, {
    allowEmpty: false,
    legacySupplement: receipt?.type === 'supplement',
    // V48.2: current regular receipts choose the delivery group once for the
    // whole supplement batch, not on every product.
    allowSupplementWithoutGroup: currentBatchSupplement,
  });
  if (!routeCheck.ok) {
    if (routeCheck.reason === 'route_required') throw appError('receipt_route_required');
    if (routeCheck.reason === 'mandatory_and_supplement') throw appError('receipt_route_conflict');
    if (routeCheck.reason === 'may_not_reach_without_mandatory') throw appError('receipt_route_warning_requires_mandatory');
    if (routeCheck.reason === 'may_not_reach_with_warehouse') throw appError('receipt_route_warning_with_warehouse');
    if (routeCheck.reason === 'supplement_group_required') throw appError('supplement_target_required');
  }
}

module.exports = {
  OWNER_ONLY_FIELDS,
  SHARED_FIELDS,
  isOwnerOrAdmin,
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  preparationMissingFields,
  assertItemReadyForRouting,
  assertItemReadyToConfirm,
};
