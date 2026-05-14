// Atomic helper: move seller (User) to a new shop, migrating their active order
// and any related PickingTask shopName references. All writes are scoped to the
// passed Mongo session so the caller can wrap the call in withTransaction().
//
// Returns: { updatedUser, movedOrder, prevGroupId, newGroupId }

const Shop = require('../models/Shop');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const PickingTask = require('../models/PickingTask');
const { getCurrentOrderingSessionId } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError } = require('../utils/errors');
const { invalidateShop } = require('../utils/modelCache');

async function ensureOrderNotInPickingPipeline(orderId, session) {
  const exists = await PickingTask.exists({
    'items.orderId': orderId,
    status: { $in: ['pending', 'locked', 'completed'] },
  }).session(session);
  if (exists) {
    throw appError('order_picking_started');
  }
}

/**
 * @param {Object} params
 * @param {import('mongoose').ClientSession} params.session    Active Mongo session (in transaction)
 * @param {Object}  params.existingUser                         User doc snapshot BEFORE the change
 * @param {Object}  params.newShopFull                          New shop doc (populated cityId)
 * @param {Object}  params.actor                                { telegramId, firstName, lastName, role }
 * @param {string}  params.reason                               history meta.reason
 * @param {boolean} [params.resetCartItems=false]               clear cartState.orderItems/orderItemIds
 * @param {boolean} [params.resetCartNavigation=false]          reset cartState navigation (lastViewedProductId, indices)
 * @param {boolean} [params.clearCartReservation=true]          clear cartState.reservedForGroupId
 * @param {boolean} [params.pushHistory=true]                   push history entry to user
 * @param {boolean} [params.updateLastSeller=true]              persist lastSeller snapshot on old shop
 */
async function migrateSellerShop({
  session,
  existingUser,
  newShopFull,
  actor,
  reason,
  resetCartItems = false,
  resetCartNavigation = false,
  clearCartReservation = true,
  pushHistory = true,
  updateLastSeller = true,
}) {
  const oldShopId = existingUser.shopId ? String(existingUser.shopId) : '';
  const newShopId = String(newShopFull._id);
  const newShopName = newShopFull.name || '';
  const newShopCity = newShopFull.cityId?.name || '';
  const newDeliveryGroupId = newShopFull.deliveryGroupId
    ? String(newShopFull.deliveryGroupId)
    : '';

  // Resolve session ids and warehouse zone for both shops.
  // CRITICAL: read Shop + DeliveryGroup with the session, NOT from cache.
  // A stale cache here would compute the wrong oldSessionId and orphan the
  // active order in the previous group. Hot cache is fine for high-frequency
  // reads (buyerSnapshot, /me, bot) but not for the one-shot migration path.
  const [oldShopFull, schedule] = await Promise.all([
    oldShopId
      ? Shop.findById(oldShopId).populate('cityId', 'name').session(session).lean()
      : Promise.resolve(null),
    getOrderingSchedule(),
  ]);

  let oldSessionId = null;
  if (oldShopFull?.deliveryGroupId) {
    const oldGroup = await DeliveryGroup.findById(oldShopFull.deliveryGroupId).session(session).lean();
    if (oldGroup) {
      oldSessionId = getCurrentOrderingSessionId(String(oldGroup._id), oldGroup.dayOfWeek, schedule);
    }
  }

  let newSessionId = null;
  let warehouseZone = '';
  if (newDeliveryGroupId) {
    const newGroup = await DeliveryGroup.findById(newDeliveryGroupId).session(session).lean();
    if (newGroup) {
      warehouseZone = newGroup.name || '';
      newSessionId = getCurrentOrderingSessionId(String(newGroup._id), newGroup.dayOfWeek, schedule);
    }
  }

  // 1. Migrate active order FIRST so a downstream write failure aborts the whole tx
  let movedOrder = null;
  let prevGroupId = null;

  if (oldShopId !== newShopId) {
    let activeOrder = null;

    if (oldShopId) {
      const orderQuery = {
        buyerTelegramId: existingUser.telegramId,
        shopId: existingUser.shopId,
        status: { $in: ['new', 'in_progress'] },
        ...(oldSessionId ? { orderingSessionId: oldSessionId } : {}),
      };
      activeOrder = await Order.findOne(orderQuery).session(session);
    } else {
      // Seller can be temporarily unassigned. In that case pick a parked active
      // order (no shop attached) and move it into the newly assigned shop.
      activeOrder = await Order.findOne({
        buyerTelegramId: existingUser.telegramId,
        status: { $in: ['new', 'in_progress'] },
        $or: [
          { shopId: null },
          { 'buyerSnapshot.shopId': null },
          { 'buyerSnapshot.shopId': { $exists: false } },
        ],
      }).sort({ updatedAt: -1, createdAt: -1 }).session(session);
    }

    if (activeOrder) {
      await ensureOrderNotInPickingPipeline(activeOrder._id, session);

      prevGroupId = activeOrder.buyerSnapshot?.deliveryGroupId
        ? String(activeOrder.buyerSnapshot.deliveryGroupId)
        : null;

      activeOrder.shopId = newShopFull._id;
      if (!activeOrder.buyerSnapshot) activeOrder.buyerSnapshot = {};
      activeOrder.buyerSnapshot.shopId = newShopId;
      activeOrder.buyerSnapshot.shopName = newShopName;
      activeOrder.buyerSnapshot.shopCity = newShopCity;
      activeOrder.buyerSnapshot.deliveryGroupId = newDeliveryGroupId;
      if (newSessionId) activeOrder.orderingSessionId = newSessionId;
      activeOrder.markModified('buyerSnapshot');
      activeOrder.history.push({
        by: String(actor.telegramId),
        byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
        byRole: actor.role,
        action: 'shop_reassigned',
        meta: {
          from: { shopName: oldShopFull?.name || '', deliveryGroupId: oldShopFull?.deliveryGroupId || '' },
          to:   { shopName: newShopName, shopCity: newShopCity, deliveryGroupId: newDeliveryGroupId },
          reason,
        },
      });
      await activeOrder.save({ session });
      movedOrder = activeOrder;

      // Sync shopName in any active PickingTask items referencing this order.
      // NB: failure here MUST abort the transaction — picking workers would otherwise
      // see a stale shop name on items they're packing.
      await PickingTask.updateMany(
        { 'items.orderId': activeOrder._id, status: { $in: ['pending', 'locked'] } },
        { $set: { 'items.$[elem].shopName': newShopName } },
        { arrayFilters: [{ 'elem.orderId': activeOrder._id }], session },
      );
    }
  }

  // 2. Update User
  const userUpdate = {
    shopId: newShopFull._id,
    deliveryGroupId: newDeliveryGroupId,
  };
  // Only sellers carry a warehouseZone-derived-from-shop; preserve other roles' values
  if (existingUser.role === 'seller') {
    userUpdate.warehouseZone = warehouseZone;
  }
  if (resetCartItems) {
    userUpdate['cartState.orderItems'] = {};
    userUpdate['cartState.orderItemIds'] = [];
    userUpdate['cartState.updatedAt'] = new Date();
  }
  if (resetCartNavigation) {
    userUpdate['cartState.lastViewedProductId'] = '';
    userUpdate['cartState.currentIndex'] = 0;
    userUpdate['cartState.currentPage'] = 0;
    userUpdate['cartState.updatedAt'] = new Date();
  }
  if (clearCartReservation) {
    userUpdate['cartState.reservedForGroupId'] = null;
  }

  const updatedUser = await User.findOneAndUpdate(
    { telegramId: existingUser.telegramId },
    { $set: userUpdate },
    { new: true, session },
  );

  // 3. Push history entry
  if (pushHistory && oldShopId !== newShopId) {
    await User.updateOne(
      { telegramId: existingUser.telegramId },
      {
        $push: {
          history: {
            at: new Date(),
            by: String(actor.telegramId),
            byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
            byRole: actor.role,
            action: 'shop_changed',
            meta: {
              fromShop: oldShopFull?.name || null,
              toShop: newShopName || null,
              reason,
              orderMoved: !!movedOrder,
            },
          },
        },
      },
      { session },
    );
  }

  // 4. Persist last-seller snapshot on the OLD shop so the hint survives reassignment
  const now = new Date();
  if (updateLastSeller && oldShopId && oldShopId !== newShopId) {
    await Shop.findByIdAndUpdate(
      oldShopId,
      {
        lastSeller: {
          telegramId:   existingUser.telegramId,
          firstName:    existingUser.firstName  || '',
          lastName:     existingUser.lastName   || '',
          unassignedAt: now,
        },
        lastSellerChangedAt: now,
      },
      { session },
    );
  }

  // 5. Mark the new shop as recently changed
  if (newShopId && newShopId !== oldShopId) {
    await Shop.findByIdAndUpdate(
      newShopId,
      { $set: { lastSellerChangedAt: now } },
      { session },
    );
  }

  // IMPORTANT: cache invalidation is intentionally NOT done here.
  // Doing it inside withTransaction would publish a stale-read window:
  // workers drop L1, read pre-commit state from the primary, and repopulate
  // the cache with the OLD value. The caller MUST call `invalidate()` from
  // the returned object AFTER session.withTransaction(...) resolves.
  return {
    updatedUser,
    movedOrder,
    prevGroupId,
    newGroupId: newDeliveryGroupId || null,
    invalidate: async () => {
      if (oldShopId) await invalidateShop(oldShopId);
      if (newShopId) await invalidateShop(newShopId);
    },
  };
}

module.exports = { migrateSellerShop };
