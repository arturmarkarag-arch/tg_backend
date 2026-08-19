'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Shop = require('../models/Shop');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { invalidateShop } = require('../utils/modelCache');
const { getIO } = require('../socket');
const { migrateSellerShop } = require('./migrateSellerShop');
const { unassignSellerAndPark } = require('./unassignSeller');

function str(value) {
  return value == null ? '' : String(value);
}

async function resolveShopGroupId(shopId, session = null) {
  if (!shopId) return null;
  const q = Shop.findById(shopId, 'deliveryGroupId').lean();
  const shop = session ? await q.session(session) : await q;
  return shop?.deliveryGroupId ? String(shop.deliveryGroupId) : null;
}

/**
 * Normalize the outcome of a CURRENT User -> Shop mutation.
 *
 * This metadata is intentionally independent from whether an Order happened to
 * move. Dashboard/cache invalidation is about assignment topology, not about
 * Order side effects. V48.19 callers previously emitted shop_status_changed only
 * when `movedOrder` existed, so a seller with no active order could move while
 * open picking/preparation screens remained stale until polling.
 */
function normalizeAssignmentTransition(result = {}, fallback = {}) {
  const fromShopId = str(result.fromShopId || fallback.fromShopId) || null;
  const toShopId = str(result.toShopId || fallback.toShopId) || null;
  const prevGroupId = str(result.prevGroupId || fallback.prevGroupId) || null;
  const newGroupId = str(result.newGroupId || fallback.newGroupId) || null;
  const sellerTelegramId = str(result.sellerTelegramId || fallback.sellerTelegramId) || null;
  const assignmentChanged = result.assignmentChanged !== undefined
    ? Boolean(result.assignmentChanged)
    : fromShopId !== toShopId;
  const orderChanged = Boolean(
    result.orderChanged
    || result.movedOrder
    || (Array.isArray(result.parkedOrderIds) && result.parkedOrderIds.length)
  );

  return {
    ...result,
    fromShopId,
    toShopId,
    prevGroupId,
    newGroupId,
    sellerTelegramId,
    assignmentChanged,
    orderChanged,
  };
}

function buildInitialAssignmentTransition({ user, shop } = {}) {
  if (!user?.telegramId || !shop?._id) return normalizeAssignmentTransition({});
  return normalizeAssignmentTransition({
    fromShopId: null,
    toShopId: String(shop._id),
    prevGroupId: null,
    newGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : null,
    sellerTelegramId: String(user.telegramId),
    assignmentChanged: true,
    orderChanged: false,
  });
}

/**
 * One post-commit publisher for every assignment transport.
 *
 * Mongo is authoritative. Cache invalidation and Socket.IO are deliberately
 * post-commit and best-effort; a socket outage must never roll back or turn a
 * successful assignment into an HTTP 500 after the transaction committed.
 */
async function publishShopAssignmentTransition(input = {}) {
  const result = normalizeAssignmentTransition(input);

  try {
    if (typeof result.invalidate === 'function') {
      await result.invalidate();
    } else {
      if (result.fromShopId) await invalidateShop(result.fromShopId);
      if (result.toShopId && result.toShopId !== result.fromShopId) {
        await invalidateShop(result.toShopId);
      }
    }
  } catch (_) { /* best-effort cache publication */ }

  if (!result.assignmentChanged) return result;

  try {
    const io = getIO();
    if (!io) return result;

    const groups = [...new Set([result.prevGroupId, result.newGroupId].filter(Boolean))];
    for (const groupId of groups) {
      io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId });
    }

    // Seller counts / topology on the group selector can change even when no
    // Order moved (initial assignment, unassign, cross-group move with no cart).
    if (result.prevGroupId !== result.newGroupId) {
      io.emit('delivery_groups_updated');
    }

    if (result.orderChanged && result.sellerTelegramId) {
      io.emit('user_order_updated', { buyerTelegramId: result.sellerTelegramId });
    }
  } catch (_) { /* best-effort realtime publication */ }

  return result;
}

/**
 * External/application command for assigning an existing User to a Shop.
 * The low-level transactional primitive remains migrateSellerShop(); this wrapper
 * owns lock + transaction + post-commit publication for ordinary HTTP callers.
 */
async function assignUserToShopCommand({
  telegramId,
  shopId,
  actor,
  reason,
  userPatch = null,
  resetCartNavigation = false,
  pushHistory = true,
  updateLastSeller = true,
  allowFrozenOrderTransfer = false,
}) {
  const tid = str(telegramId).trim();
  const targetId = str(shopId).trim();
  if (!tid) throw appError('user_not_found');
  if (!targetId) throw appError('shop_not_found');

  const result = await withLock(`user:${tid}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        if (userPatch && Object.keys(userPatch).length > 0) {
          await User.updateOne({ telegramId: tid }, { $set: userPatch }, { session });
        }

        const freshUser = await User.findOne({ telegramId: tid }).session(session).lean();
        if (!freshUser) throw appError('user_not_found');

        const targetShop = await Shop.findById(targetId)
          .populate('cityId', 'name')
          .session(session)
          .lean();
        if (!targetShop) throw appError('shop_not_found');

        out = await migrateSellerShop({
          session,
          existingUser: freshUser,
          newShopFull: targetShop,
          actor,
          reason,
          resetCartNavigation,
          pushHistory,
          updateLastSeller,
          allowFrozenOrderTransfer,
        });
      });
      return out;
    } finally {
      await session.endSession();
    }
  });

  return publishShopAssignmentTransition(result);
}

/**
 * External/application command for removing the current Shop assignment.
 * Order parked/frozen ownership remains owned by unassignSellerAndPark().
 * Parking is represented by Order.status=new_unassign; Order shop/group/session ownership is preserved.
 */
async function unassignUserFromShopCommand({
  telegramId,
  actor,
  reason,
  userPatch = null,
  updateLastSeller = true,
  allowFrozenOrderPark = false,
}) {
  const tid = str(telegramId).trim();
  if (!tid) throw appError('user_not_found');

  const result = await withLock(`user:${tid}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        const before = await User.findOne({ telegramId: tid }).session(session);
        if (!before) throw appError('user_not_found');

        const fromShopId = before.shopId ? String(before.shopId) : null;
        const prevGroupId = await resolveShopGroupId(fromShopId, session);

        if (userPatch && Object.keys(userPatch).length > 0) {
          await User.updateOne({ telegramId: tid }, { $set: userPatch }, { session });
        }

        const freshUser = await User.findOne({ telegramId: tid }).session(session);
        if (!freshUser) throw appError('user_not_found');

        const unassignResult = await unassignSellerAndPark({
          session,
          seller: freshUser,
          fromShopId,
          actor,
          reason,
          allowFrozenOrderPark,
        });

        if (updateLastSeller && fromShopId) {
          const now = new Date();
          await Shop.findByIdAndUpdate(
            fromShopId,
            {
              $set: {
                lastSellerChangedAt: now,
                lastSeller: {
                  telegramId: freshUser.telegramId,
                  firstName: freshUser.firstName || '',
                  lastName: freshUser.lastName || '',
                  unassignedAt: now,
                },
              },
            },
            { session },
          );
        }

        const updatedUser = await User.findOne({ telegramId: tid }).session(session).lean();
        out = normalizeAssignmentTransition(unassignResult, {
          updatedUser,
          fromShopId,
          toShopId: null,
          prevGroupId,
          newGroupId: null,
          sellerTelegramId: tid,
        });
        out.updatedUser = updatedUser;
      });
      return out;
    } finally {
      await session.endSession();
    }
  });

  return publishShopAssignmentTransition(result);
}

module.exports = {
  normalizeAssignmentTransition,
  buildInitialAssignmentTransition,
  publishShopAssignmentTransition,
  assignUserToShopCommand,
  unassignUserFromShopCommand,
};
