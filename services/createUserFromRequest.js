'use strict';
// Shared "turn an approved/eligible applicant into a User" logic, used by BOTH
// the admin approve path (warehouse) and seller auto-registration. Validates the
// seller's shop (must exist and be active) and creates the User inside the
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
const { appError } = require('../utils/errors');

async function resolveAndCreateUser({
  session,
  telegramId,
  role,
  firstName,
  lastName,
  phoneNumber,
  shopId,
}) {
  let resolvedShopId = null;

  if (role === 'seller' && shopId) {
    const shop = await Shop.findOne({ _id: shopId, isActive: true })
      .session(session)
      .lean();
    if (!shop) throw appError('registration_shop_inactive');
    resolvedShopId = shop._id;
  }

  // Група доставки НЕ копіюється в User: вона належить магазину. Заявка
  // (RegistrationRequest.deliveryGroupId) свою копію зберігає — це знімок умов
  // подання, і саме він гейтить approve.
  const [user] = await User.create([{
    telegramId,
    role,
    firstName,
    lastName,
    phoneNumber: phoneNumber || '',
    shopId: resolvedShopId,
  }], { session });

  return user;
}

module.exports = { resolveAndCreateUser };
