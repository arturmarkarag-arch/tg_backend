'use strict';
// Shared "turn an approved/eligible applicant into a User" logic, used by BOTH
// the admin approve path (warehouse) and seller auto-registration. Resolves the
// seller's shop → deliveryGroup → warehouseZone and creates the User inside the
// caller's transaction.
//
// create() (not upsert) is deliberate: a concurrent create of the same
// telegramId throws E11000 against the unique index, which callers map to
// registration_user_exists — a loud, correct error instead of silently
// returning someone else's user.
//
// NOTE: googleEmail is intentionally NOT set here. Google identity is proven via
// OAuth and attached later through /auth/google/link/* — never copied from a
// self-typed registration field.

const User = require('../models/User');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const { appError } = require('../utils/errors');

async function resolveAndCreateUser({
  session,
  telegramId,
  role,
  firstName,
  lastName,
  phoneNumber,
  shopId,
  deliveryGroupId,
}) {
  let resolvedShopId = null;
  let resolvedDeliveryGroupId = role === 'seller' ? (deliveryGroupId || '') : '';
  let resolvedWarehouseZone = '';

  if (role === 'seller' && shopId) {
    const shop = await Shop.findOne({ _id: shopId, isActive: true })
      .populate('cityId', 'name')
      .session(session)
      .lean();
    if (!shop) throw appError('registration_shop_inactive');
    resolvedShopId = shop._id;
    resolvedDeliveryGroupId = shop.deliveryGroupId || resolvedDeliveryGroupId;
    if (resolvedDeliveryGroupId) {
      const grp = await DeliveryGroup.findById(resolvedDeliveryGroupId).session(session).lean();
      resolvedWarehouseZone = grp?.name || '';
    }
  }

  const [user] = await User.create([{
    telegramId,
    role,
    firstName,
    lastName,
    phoneNumber: phoneNumber || '',
    shopId: resolvedShopId,
    deliveryGroupId: resolvedDeliveryGroupId,
    warehouseZone: resolvedWarehouseZone,
  }], { session });

  return user;
}

module.exports = { resolveAndCreateUser };
