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

function duplicateKeyMatches(err, fields = []) {
  if (!err || err.code !== 11000) return false;
  const pattern = err.keyPattern && typeof err.keyPattern === 'object' ? err.keyPattern : {};
  if (fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(pattern, field))) return true;
  const message = String(err.message || '');
  return fields.length > 0 && fields.every((field) => message.includes(field));
}

function isAssignmentRetryableDuplicate(err) {
  return duplicateKeyMatches(err, ['groupId', 'openDate'])
    || duplicateKeyMatches(err, ['buyerTelegramId', 'shopId', 'orderingSessionId']);
}


function assertAssignmentOwnedFieldsAbsent(userPatch) {
  if (!userPatch || typeof userPatch !== 'object') return;
  if (
    Object.prototype.hasOwnProperty.call(userPatch, 'shopId')
  ) {
    throw appError('validation_failed', {
      field: 'shopId',
      details: 'assignment_owned_field',
    });
  }
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
      const shopIds = [...new Set([
        result.fromShopId,
        result.toShopId,
        ...(Array.isArray(result.affectedShopIds) ? result.affectedShopIds : []),
      ].filter(Boolean).map(String))];
      for (const shopId of shopIds) await invalidateShop(shopId);
    }
  } catch (_) { /* best-effort cache publication */ }

  // Publication is topology/event driven, not assignment-only. Explicit Order
  // ownership repair may change a live Order while User.shopId is already correct
  // (or while the historical author account no longer exists). Such a change must
  // still refresh affected picking groups and the seller order projection.
  if (!result.assignmentChanged && !result.orderChanged) return result;

  try {
    const io = getIO();
    if (!io) return result;

    const groups = [...new Set([
      result.prevGroupId,
      result.newGroupId,
      ...(Array.isArray(result.affectedGroupIds) ? result.affectedGroupIds : []),
    ].filter(Boolean).map(String))];
    for (const groupId of groups) {
      io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId });
    }

    // Seller counts / topology on the group selector change only when CURRENT
    // assignment topology changes. A pure Order ownership repair must not pretend
    // that sellers moved between groups.
    if (result.assignmentChanged && result.prevGroupId !== result.newGroupId) {
      io.emit('delivery_groups_updated');
    }

    // Every committed CURRENT seller assignment change must reach the seller's
    // open app, even when old/new Shops belong to the SAME DeliveryGroup. The
    // client already owns one canonical handler for this event: it re-fetches
    // the profile, which changes shopId and refreshes ordering status.
    if (result.assignmentChanged && result.sellerTelegramId) {
      io.emit('user_shop_changed', { telegramId: result.sellerTelegramId });
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
  expectedOrderingSessionId = null,
}) {
  assertAssignmentOwnedFieldsAbsent(userPatch);
  const tid = str(telegramId).trim();
  const targetId = str(shopId).trim();
  if (!tid) throw appError('user_not_found');
  if (!targetId) throw appError('shop_not_found');

  const result = await withLock(`user:${tid}:shop`, async () => {
    // A destination OrderingSession or active Order can be created by another
    // worker between our reads and writes. Mongo reports that race as E11000.
    // Retry the WHOLE transaction while the user-assignment lock is still held;
    // retrying inside an already-aborted transaction is invalid. The second pass
    // re-reads every source/destination document and either succeeds or produces
    // an explicit assignment invariant instead of leaking generic duplicate_key.
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
            expectedOrderingSessionId,
          });
        });
        return out;
      } catch (err) {
        if (attempt === 0 && isAssignmentRetryableDuplicate(err)) {
          // Yield once so the winner of the competing unique insert can commit.
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        if (duplicateKeyMatches(err, ['buyerTelegramId', 'shopId', 'orderingSessionId'])) {
          throw appError('shop_switch_order_conflict');
        }
        if (duplicateKeyMatches(err, ['groupId', 'openDate'])) {
          throw appError('ordering_session_changed');
        }
        throw err;
      } finally {
        await session.endSession();
      }
    }
    throw appError('conflict_retry');
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
  orderingSessionId = null,
}) {
  assertAssignmentOwnedFieldsAbsent(userPatch);
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
          orderingSessionId,
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
