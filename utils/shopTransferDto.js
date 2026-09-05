'use strict';

const ROOT_FIELDS = '_id sellerTelegramId sellerName isAssignment isProfileOnly fromShopId fromShopName fromDeliveryGroupId toShopId toShopName toDeliveryGroupId status resolvedAt resolvedBy resolvedByName rejectReason createdAt updatedAt'.split(' ');
const SNAPSHOT_FIELDS = 'targetShopHasSeller targetShopSellerName targetShopSellerTelegramId targetSellerHasActiveOrder targetSellerActiveOrderId sourceShopHasActiveOrder sourceShopActiveOrderId targetShopAdminNames targetShopSellerCount targetShopActiveOrderCount targetShopDistinctBuyerCount targetShopHasConflict'.split(' ');
const PROFILE_FIELDS = ['firstName', 'lastName', 'phoneNumber'];
const TRANSFER_FIELDS = [
  ...ROOT_FIELDS,
  ...SNAPSHOT_FIELDS.map((field) => `conflictSnapshot.${field}`),
  ...PROFILE_FIELDS.map((field) => `profileUpdate.${field}`),
].join(' ');

const pick = (value, fields) => Object.fromEntries(fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
function toShopTransferDto(value) {
  if (!value) return null;
  return {
    ...pick(value, ROOT_FIELDS),
    conflictSnapshot: pick(value.conflictSnapshot, SNAPSHOT_FIELDS),
    profileUpdate: pick(value.profileUpdate, PROFILE_FIELDS),
  };
}

module.exports = { TRANSFER_FIELDS, toShopTransferDto };
