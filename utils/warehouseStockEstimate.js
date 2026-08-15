'use strict';

// Informational-only warehouse estimate. `orderedPackages` is the X multiplier
// chosen by sellers (ordinary ordering + supplement ordering). The calculation
// intentionally uses the CURRENT pack size because historical order rows do not
// snapshot quantityPerPackage.
function buildWarehouseStockEstimate({
  receivedQty = null,
  regularOrderedPackages = 0,
  supplementOrderedPackages = 0,
  quantityPerPackage = 0,
} = {}) {
  const received = Number.isFinite(Number(receivedQty)) && receivedQty !== null
    ? Number(receivedQty)
    : null;
  const regular = Math.max(0, Number(regularOrderedPackages || 0));
  const supplement = Math.max(0, Number(supplementOrderedPackages || 0));
  const packSize = Math.max(0, Number(quantityPerPackage || 0));
  const orderedPackages = regular + supplement;
  const orderedUnits = packSize > 0 ? orderedPackages * packSize : null;
  const estimatedRemaining = received != null && orderedUnits != null
    ? received - orderedUnits
    : null;

  return {
    receivedQty: received,
    regularOrderedPackages: regular,
    supplementOrderedPackages: supplement,
    orderedPackages,
    quantityPerPackage: packSize,
    orderedUnits,
    estimatedRemaining,
    informationalOnly: true,
  };
}

module.exports = { buildWarehouseStockEstimate };
