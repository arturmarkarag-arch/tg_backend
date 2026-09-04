/**
 * Deprecated compatibility shim.
 *
 * BaseLinker statuses are now an explicit upstream display/filter choice only.
 * They must not act as a second hidden eligibility gate for local fulfilment.
 * Keep these exports temporarily so a mixed/manual deploy of an older caller
 * cannot re-introduce fail-closed status filtering while files are being
 * replaced. New code must not import this module.
 */
async function getBaseLinkerPickingSettings() {
  return {
    eligibleStatusIds: [],
    configured: false,
    deprecated: true,
  };
}

async function saveBaseLinkerPickingSettings() {
  return getBaseLinkerPickingSettings();
}

async function assertOrderEligibleForPicking(order) {
  return order;
}

module.exports = {
  getBaseLinkerPickingSettings,
  saveBaseLinkerPickingSettings,
  assertOrderEligibleForPicking,
};
