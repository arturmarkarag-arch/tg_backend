/**
 * Multi-worker receipt item rules.
 *
 * `createdBy` is immutable provenance (who physically accepted the row), NOT an
 * edit lock. Every authenticated receipt staff member (admin or warehouse) may
 * prepare, route, confirm and correct a row. Concurrency is protected separately
 * by per-row edit/routing revisions, so widening permissions never becomes
 * last-write-wins ownership stealing.
 *
 * Deletion deliberately stays narrower: draft rows may be removed by their
 * original receiver or an admin; confirmed rows only by an admin.
 */

const { appError } = require('./errors');
const { normalizeReceiptItemRouting, validateReceiptItemRouting } = require('./receiptRouting');

const OWNER_ONLY_FIELDS = new Set([]);
const SHARED_FIELDS = new Set([
  'price', 'qtyPerPackage', 'photoUrl', 'photoMeta', 'totalQty', 'originalPhotoUrl',
  'destination', 'routing', 'deliveryGroupIds', 'qtyPerShop',
]);

function isReceiptStaff(user) {
  return !!user && (user.role === 'admin' || user.role === 'warehouse');
}

function isOwnerOrAdmin(user, item) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!item.createdBy && String(item.createdBy) === String(user.telegramId);
}

function assertCanEditItem(user, item, changedFields) {
  if (!isReceiptStaff(user)) throw appError('forbidden');
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
  if (!isReceiptStaff(user)) throw appError('forbidden');
}

function isModernReceiptItem(item) {
  return Number(item?.routingVersion || 0) >= 1;
}

function preparationMissingFields(item) {
  const missing = [];
  if (!item?.photoUrl) missing.push('фото');
  // `totalQty` is optional receiving metadata in the modern staged flow. Legacy
  // rows still require it because their Product.quantity historically derives
  // from this field and dropping it would corrupt the old stock contract.
  if (!isModernReceiptItem(item) && !(Number(item?.totalQty) >= 1)) {
    missing.push('кількість що приїхала');
  }
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
 *   - photo is the receiving requirement; received qty is optional for modern rows;
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
  isReceiptStaff,
  isOwnerOrAdmin,
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  isModernReceiptItem,
  preparationMissingFields,
  assertItemReadyForRouting,
  assertItemReadyToConfirm,
};
