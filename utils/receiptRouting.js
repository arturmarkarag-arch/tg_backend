'use strict';

/**
 * Receipt-item routing compatibility layer.
 *
 * New rows store the real business intent in item.routing:
 *   warehouse  — make the product available through the normal warehouse flow
 *   mandatory  — warehouse distributes it to shops itself (seller does not order)
 *   supplement — seller may order it through the supplement flow
 *
 * warehouse may be combined with mandatory OR supplement.
 * mandatory + supplement is deliberately invalid.
 *
 * Legacy rows are still interpreted from Receipt.type + item.destination so old
 * receipts keep working without a destructive migration.
 */

function blankRouting() {
  return {
    warehouse: false,
    mandatory: false,
    supplement: false,
    mayNotReachAllShops: false,
    supplementDeliveryGroupId: null,
  };
}

function hasExplicitRouting(item) {
  if (!item || !item.routing) return false;
  if (Number(item.routingVersion || 0) >= 1) return true;
  const r = item.routing;
  return !!(
    r.warehouse || r.mandatory || r.supplement || r.mayNotReachAllShops || r.supplementDeliveryGroupId
  );
}

function normalizeReceiptItemRouting(item, receipt = null) {
  if (hasExplicitRouting(item)) {
    return {
      warehouse: !!item.routing.warehouse,
      mandatory: !!item.routing.mandatory,
      supplement: !!item.routing.supplement,
      mayNotReachAllShops: !!item.routing.mayNotReachAllShops,
      supplementDeliveryGroupId: item.routing.supplementDeliveryGroupId
        ? String(item.routing.supplementDeliveryGroupId)
        : null,
    };
  }

  // Legacy supplement receipt: every item was historically a shelf item and the
  // whole receipt opened the supplement wave. Preserve that exact meaning.
  if (receipt?.type === 'supplement') {
    return {
      warehouse: true,
      mandatory: false,
      supplement: true,
      mayNotReachAllShops: false,
      supplementDeliveryGroupId: receipt.targetDeliveryGroupId
        ? String(receipt.targetDeliveryGroupId)
        : null,
    };
  }

  // Legacy regular rows used destination XOR. `shops` is the closest historical
  // equivalent of today's mandatory direct-to-shops route.
  if ((item?.destination || 'shelf') === 'shops') {
    return {
      warehouse: false,
      mandatory: true,
      supplement: false,
      mayNotReachAllShops: false,
      supplementDeliveryGroupId: null,
    };
  }

  // Old shelf rows remain ordinary warehouse goods.
  if (item?.destination) {
    return {
      warehouse: true,
      mandatory: false,
      supplement: false,
      mayNotReachAllShops: false,
      supplementDeliveryGroupId: null,
    };
  }

  // Brand-new rows may intentionally be received before any route is selected.
  return blankRouting();
}

function legacyDestinationForRouting(routing) {
  const r = routing || blankRouting();
  // The only route that must NOT create a warehouse Product is mandatory-only.
  // Everything involving warehouse OR supplement needs a Product (supplement
  // picking needs a stable productId even when the item is hidden from normal ordering).
  return r.mandatory && !r.warehouse && !r.supplement ? 'shops' : 'shelf';
}

function validateReceiptItemRouting(
  routing,
  { allowEmpty = false, legacySupplement = false, allowSupplementWithoutGroup = false } = {},
) {
  const r = {
    ...blankRouting(),
    ...(routing || {}),
  };

  if (r.mandatory && r.supplement) {
    return { ok: false, reason: 'mandatory_and_supplement' };
  }
  if (r.mayNotReachAllShops && !r.mandatory) {
    return { ok: false, reason: 'may_not_reach_without_mandatory' };
  }
  // If the item also goes to the warehouse, the business meaning is that the
  // mandatory allocation was satisfied and there is still stock left for the
  // next normal session. Marking the same row as "may not reach everyone" is
  // contradictory, independent of the non-authoritative received quantity.
  if (r.mayNotReachAllShops && r.warehouse) {
    return { ok: false, reason: 'may_not_reach_with_warehouse' };
  }
  if (!allowEmpty && !r.warehouse && !r.mandatory && !r.supplement) {
    return { ok: false, reason: 'route_required' };
  }
  if (r.supplement && !legacySupplement && !allowSupplementWithoutGroup && !r.supplementDeliveryGroupId) {
    return { ok: false, reason: 'supplement_group_required' };
  }
  return { ok: true, routing: r };
}

function isNormalOrderingEnabled(routing) {
  const r = routing || blankRouting();
  // A supplement-only Product exists for physical handling / supplement picking,
  // but must not leak into the ordinary seller catalogue. Warehouse explicitly
  // opted-in means it may participate in the normal warehouse ordering flow.
  if (r.supplement && !r.warehouse) return false;
  return !!r.warehouse;
}

module.exports = {
  blankRouting,
  hasExplicitRouting,
  normalizeReceiptItemRouting,
  legacyDestinationForRouting,
  validateReceiptItemRouting,
  isNormalOrderingEnabled,
};
