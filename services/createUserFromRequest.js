'use strict';
// Shared "turn an approved/eligible applicant into an ACTIVE User" logic, used
// by BOTH the admin approve path (warehouse) and seller auto-registration.
//
// A normal active account is still unique by telegramId. The one exception is
// a SOFT-REMOVED account: its row intentionally stays in Mongo as history, so a
// later valid registration reactivates that SAME row instead of trying to
// insert a duplicate telegramId.

const User = require('../models/User');
const Shop = require('../models/Shop');
const GroupMember = require('../models/GroupMember');
const { appError } = require('../utils/errors');
const { isRemovedUser } = require('../utils/userAccountState');
const { migrateSellerShop } = require('./migrateSellerShop');

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
  let resolvedShop = null;

  if (role === 'seller' && shopId) {
    resolvedShop = await Shop.findOne({ _id: shopId, isActive: true })
      .populate('cityId', 'name')
      .session(session)
      .lean();
    if (!resolvedShop) throw appError('registration_shop_inactive');
    resolvedShopId = resolvedShop._id;
  }

  const existing = await User.findOne({ telegramId: String(telegramId) }).session(session);
  if (existing && !isRemovedUser(existing)) {
    throw appError('registration_user_exists');
  }

  if (existing && isRemovedUser(existing)) {
    const now = new Date();
    const previousRemovedAt = existing.removedAt || null;
    // If this seller had an active order parked when their account was removed,
    // re-registration must reattach it through the canonical shop-migration path
    // instead of leaving an invisible shopId=null order behind.
    if (role === 'seller' && resolvedShop) {
      await migrateSellerShop({
        session,
        existingUser: existing.toObject(),
        newShopFull: resolvedShop,
        actor: {
          telegramId: String(telegramId),
          firstName: firstName || existing.firstName || '',
          lastName: lastName || existing.lastName || '',
          role: 'seller',
        },
        reason: 'account_reregistered',
        resetCartNavigation: true,
        pushHistory: false,
        updateLastSeller: false,
      });
    }

    existing.role = role;
    existing.firstName = firstName;
    existing.lastName = lastName;
    existing.phoneNumber = phoneNumber || '';
    existing.shopId = resolvedShopId;
    existing.shopNumber = '';
    existing.accountState = 'active';
    existing.removedAt = null;
    existing.removedByTelegramId = '';
    // A successful registration is an explicit return to the system. Keep the
    // historical Google link, but clear stale runtime/account flags.
    existing.botBlocked = false;
    existing.isOnline = false;
    existing.isWarehouseManager = false;
    existing.isOnShift = false;
    existing.shiftZone = { startBlock: null, endBlock: null };
    existing.miniAppState = {
      lastViewedProductId: '', currentIndex: 0, currentPage: 0,
      viewMode: 'carousel', updatedAt: null,
    };
    existing.cartState = {
      orderItems: {}, orderItemIds: [], lastOrderPositions: 0,
      navigationSessionId: '', lastViewedProductId: '',
      lastViewedOrderNumber: 0, currentIndex: 0, currentPage: 0,
      updatedAt: null,
    };
    existing.history.push({
      at: now,
      by: String(telegramId),
      byName: [firstName, lastName].filter(Boolean).join(' '),
      byRole: role,
      action: 'account_reregistered',
      meta: { previousRemovedAt },
    });
    await existing.save({ session });

    // The group monitor's "Видалити" also hides GroupMember rows. Successful
    // re-registration makes the person visible again automatically.
    await GroupMember.updateMany(
      { telegramId: String(telegramId) },
      { $set: { hiddenAt: null, hiddenByTelegramId: '' } },
      { session },
    );

    return existing;
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
    accountState: 'active',
  }], { session });

  // If an old GroupMember row was manually hidden before this account existed,
  // a legitimate first registration should bring it back into the live list.
  await GroupMember.updateMany(
    { telegramId: String(telegramId) },
    { $set: { hiddenAt: null, hiddenByTelegramId: '' } },
    { session },
  );

  return user;
}

module.exports = { resolveAndCreateUser };
