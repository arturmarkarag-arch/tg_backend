'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Shop = require('../models/Shop');
const GroupMember = require('../models/GroupMember');
const PickingTask = require('../models/PickingTask');
const { unassignSellerAndPark } = require('./unassignSeller');
const { withLock } = require('../utils/lock');
const { invalidateShop } = require('../utils/modelCache');
const { isRemovedUser } = require('../utils/userAccountState');

/**
 * Soft-remove a system account while preserving the User document as history.
 *
 * Effects:
 *  - accountState=removed => all HTTP/socket auth is denied;
 *  - browser sessions are revoked immediately;
 *  - seller/admin shop relation is detached through the canonical unassign flow
 *    (unpisked active orders are parked; in-pipeline orders stay warehouse-owned);
 *  - warehouse locks are released so a removed worker cannot strand tasks;
 *  - GroupMember rows are hidden from all Telegram-group monitor lists;
 *  - User + GroupMember documents remain in Mongo and can be reactivated only by
 *    the normal registration flow (live group membership + valid invite + form).
 */
async function softRemoveUser({ telegramId, actor = null, groupChatId = '' }) {
  const tid = String(telegramId || '').trim();
  if (!tid) throw new Error('telegramId_required');

  return withLock(`user:${tid}:soft-remove`, async () => {
    const session = await mongoose.connection.startSession();
    let oldShopId = null;
    let userExisted = false;
    let alreadyRemoved = false;
    const now = new Date();

    try {
      await session.withTransaction(async () => {
        const user = await User.findOne({ telegramId: tid }).session(session);
        userExisted = Boolean(user);

        // Hide every observed row for this identity. Removing access is global,
        // so the same person must not remain visible in another allowed group.
        const hiddenBy = String(actor?.telegramId || '');
        const hideUpdate = {
          $set: { hiddenAt: now, hiddenByTelegramId: hiddenBy },
        };
        const hidden = await GroupMember.updateMany({ telegramId: tid }, hideUpdate, { session });
        if (!hidden.matchedCount && groupChatId) {
          await GroupMember.updateOne(
            { groupChatId: String(groupChatId), telegramId: tid },
            {
              ...hideUpdate,
              $setOnInsert: {
                username: '', firstName: '', lastName: '', photoFileId: '', isBot: false,
                lastSeenAt: null, joinedAt: null, left: false, telegramStatus: '',
                statusCheckedAt: null, statusCheckError: '', welcomeChatId: '', welcomeMessageId: null,
              },
            },
            { upsert: true, session },
          );
        }

        if (!user) return;
        alreadyRemoved = isRemovedUser(user);
        if (alreadyRemoved) return;

        oldShopId = user.shopId ? String(user.shopId) : null;

        // Detach sellers/admins through the SAME business path used by a normal
        // unassignment, so active orders are not orphaned on an old shop.
        if (oldShopId && ['seller', 'admin'].includes(user.role)) {
          await unassignSellerAndPark({
            session,
            seller: user,
            fromShopId: oldShopId,
            actor: actor || { telegramId: 'system', firstName: '', lastName: '', role: 'system' },
            reason: 'account_soft_removed',
          });

          await Shop.findByIdAndUpdate(
            oldShopId,
            {
              $set: {
                lastSellerChangedAt: now,
                lastSeller: {
                  telegramId: user.telegramId,
                  firstName: user.firstName || '',
                  lastName: user.lastName || '',
                  unassignedAt: now,
                },
              },
            },
            { session },
          );
        }

        // A removed warehouse worker must not hold a lock that no active account
        // can finish. Return those tasks to the common pending pool atomically.
        if (user.role === 'warehouse') {
          await PickingTask.updateMany(
            { lockedBy: tid, status: 'locked' },
            { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
            { session },
          );
        }

        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              accountState: 'removed',
              removedAt: now,
              removedByTelegramId: String(actor?.telegramId || ''),
              sessionsValidFrom: now,
              isOnline: false,
              isOnShift: false,
              isWarehouseManager: false,
              shiftZone: { startBlock: null, endBlock: null },
              // unassignSellerAndPark already clears this for seller/admin; set it
              // here too so every role has zero operational ownership after removal.
              shopId: null,
              shopNumber: '',
            },
            $push: {
              history: {
                at: now,
                by: String(actor?.telegramId || 'system'),
                byName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' '),
                byRole: actor?.role || 'system',
                action: 'account_soft_removed',
                meta: { oldShopId: oldShopId || '', sourceGroupChatId: String(groupChatId || '') },
              },
            },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    if (oldShopId) await invalidateShop(oldShopId);
    return { ok: true, userExisted, alreadyRemoved, removedAt: now, oldShopId };
  });
}

module.exports = { softRemoveUser };
