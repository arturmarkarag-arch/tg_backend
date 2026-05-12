const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const City = require('../models/City');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const { isOrderingOpen, getOrderingWindowOpenAt, getCurrentOrderingSessionId } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const PickingTask = require('../models/PickingTask');
const { getIO } = require('../socket');
const { migrateSellerShop } = require('../services/migrateSellerShop');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function syncUserWarehouseZone(user) {
  if (user.role === 'seller') {
    let zone = '';
    // New architecture: derive zone from shop -> deliveryGroup
    if (user.shopId) {
      const shop = await Shop.findById(user.shopId).lean();
      if (shop?.deliveryGroupId) {
        const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
        zone = group?.name || '';
      }
    } else if (user.deliveryGroupId) {
      // Legacy fallback
      const group = await DeliveryGroup.findById(user.deliveryGroupId).lean();
      zone = group?.name || '';
    }
    return await User.findByIdAndUpdate(user._id, { warehouseZone: zone }, { new: true });
  }
  if (user.role !== 'warehouse') {
    return await User.findByIdAndUpdate(user._id, { warehouseZone: '' }, { new: true });
  }
  return user;
}

async function sanitizeUserPayload(payload, existing = null) {
  const role = payload.role ?? existing?.role ?? 'seller';
  const data = {
    // telegramId — імьютабельний, не приймається тут; передається окремо тільки при створенні
    role,
    firstName: payload.firstName,
    lastName: payload.lastName,
    phoneNumber: payload.phoneNumber,
    // Explicitly cast to Boolean so strings "true"/"false" or 1/0 from HTTP body never
    // reach MongoDB as a wrong type. Skip the field entirely when not provided.
    ...(payload.botBlocked !== undefined && payload.botBlocked !== null
      ? { botBlocked: Boolean(payload.botBlocked === 'false' ? false : payload.botBlocked) }
      : {}),
  };

  // Seller-specific fields — clear when role is not seller
  if (role === 'seller') {
    data.shopId = payload.shopId || null;
    data.shopNumber = payload.shopNumber;
    data.shopName = payload.shopName;
    data.shopAddress = payload.shopAddress;
    data.shopCity = payload.shopCity;
    // deliveryGroupId is derived from the shop — never trust client-supplied value
    if (data.shopId) {
      const shop = await Shop.findById(data.shopId).lean();
      data.deliveryGroupId = shop?.deliveryGroupId || '';
    } else {
      data.deliveryGroupId = '';
    }
  } else {
    data.shopId = null;
    data.shopNumber = '';
    data.shopName = '';
    data.shopAddress = '';
    data.shopCity = '';
    data.deliveryGroupId = '';
  }

  // Warehouse-specific fields — clear when role is not warehouse
  if (role === 'warehouse') {
    data.isWarehouseManager = Boolean(payload.isWarehouseManager);
    data.warehouseZone = payload.warehouseZone;
  } else {
    data.isWarehouseManager = false;
    data.isOnShift = false;
    data.shiftZone = { startBlock: null, endBlock: null };
  }

  return data;
}

router.get('/', asyncHandler(async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 20));
  const roleFilter     = req.query.role || null;
  const groupFilter    = req.query.deliveryGroupId || null;
  const cityFilter     = req.query.shopCity || null;
  const activityFilter = req.query.activityFilter || null; // 'no_cart' | 'no_order' | 'no_visit'

  const filter = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (groupFilter && groupFilter !== 'all') filter.deliveryGroupId = groupFilter;
  if (cityFilter && cityFilter !== 'all') {
    const city = await City.findOne({ name: cityFilter }).lean();
    if (city) {
      const shopsInCity = await Shop.find({ cityId: city._id }, '_id').lean();
      filter.shopId = { $in: shopsInCity.map((s) => s._id) };
    } else {
      // No city found — return empty
      filter.shopId = { $in: [] };
    }
  }

  // Window info — only when filtering sellers in a specific group
  let windowIsOpen = false;
  let windowOpenAt = null;
  const isSellerGroupView = roleFilter === 'seller' && groupFilter && groupFilter !== 'all';

  if (isSellerGroupView) {
    const group = await DeliveryGroup.findById(groupFilter).lean();
    if (group) {
      const { isOpen } = isOrderingOpen(group.dayOfWeek);
      windowIsOpen = isOpen;
      windowOpenAt = getOrderingWindowOpenAt(group.dayOfWeek);
    }
  }

  let users;
  let total;

  if (activityFilter === 'no_order' && windowIsOpen && windowOpenAt) {
    // no_order: join with orders via aggregation — never loads all users into RAM
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'orders',
          let: { tid: '$telegramId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$buyerTelegramId', '$$tid'] },
                createdAt: { $gte: windowOpenAt },
                status: { $nin: ['cancelled', 'expired'] },
              },
            },
            { $limit: 1 },
          ],
          as: '_windowOrders',
        },
      },
      { $match: { _windowOrders: { $size: 0 } } },
      { $unset: '_windowOrders' },
      {
        $facet: {
          meta: [{ $count: 'count' }],
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
          ],
        },
      },
    ];
    const [result] = await User.aggregate(pipeline);
    total = result?.meta?.[0]?.count ?? 0;
    users = (result?.data ?? []).map((u) => ({
      ...u,
      windowOrderQty: 0, // by definition — these users have no window orders
    }));
  } else if (activityFilter && windowIsOpen && windowOpenAt) {
    // no_cart / no_visit: push filter to MongoDB query — no in-memory scan
    if (activityFilter === 'no_cart') {
      // Cart is stored on User.cartState — sellers with an empty cart are those
      // whose cartState.orderItemIds array is missing or empty.
      filter['$or'] = [
        { 'cartState.orderItemIds': { $exists: false } },
        { 'cartState.orderItemIds': { $size: 0 } },
      ];
    } else if (activityFilter === 'no_visit') {
      filter['$or'] = [
        { 'miniAppState.updatedAt': null },
        { 'miniAppState.updatedAt': { $lt: windowOpenAt } },
      ];
    }
    const [countResult, pageUsers] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    ]);
    total = countResult;
    users = pageUsers;
    // Enrich with order data for display
    const activityTids = users.map((u) => u.telegramId).filter(Boolean);
    const activityOrders = await Order.aggregate([
      { $match: { buyerTelegramId: { $in: activityTids }, createdAt: { $gte: windowOpenAt }, status: { $nin: ['cancelled', 'expired'] } } },
      { $unwind: '$items' },
      { $group: { _id: '$buyerTelegramId', totalQty: { $sum: '$items.quantity' } } },
    ]);
    const activityOrderQtyMap = new Map(activityOrders.map((o) => [o._id, o.totalQty]));
    users = users.map((u) => ({
      ...u,
      windowOrderQty: activityOrderQtyMap.get(u.telegramId) || 0,
    }));
  } else {
    const [countResult, pageUsers] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    ]);
    total = countResult;
    users = pageUsers;

    // Enrich with window data when viewing a specific seller group
    if (isSellerGroupView && windowIsOpen && windowOpenAt) {
      const telegramIds = users.map((u) => u.telegramId).filter(Boolean);
      const windowOrders = await Order.aggregate([
        { $match: { buyerTelegramId: { $in: telegramIds }, createdAt: { $gte: windowOpenAt }, status: { $nin: ['cancelled', 'expired'] } } },
        { $unwind: '$items' },
        { $group: { _id: '$buyerTelegramId', totalQty: { $sum: '$items.quantity' } } },
      ]);
      const orderQtyMap = new Map(windowOrders.map((o) => [o._id, o.totalQty]));
      users = users.map((u) => ({
        ...u,
        windowOrderQty: orderQtyMap.get(u.telegramId) || 0,
      }));
    }
  }

  // Cart lives on User.cartState — derive itemCount directly from each user doc.
  const getCartCount = (u) => {
    const items = u?.cartState?.orderItems;
    if (!items) return 0;
    const obj = items instanceof Map ? Object.fromEntries(items) : items;
    return Object.values(obj).reduce((s, q) => s + (Number(q) || 0), 0);
  };

  const telegramIds = users.map((u) => u.telegramId).filter(Boolean);
  const lastOrders = await Order.aggregate([
    { $match: { buyerTelegramId: { $in: telegramIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$buyerTelegramId', lastOrderAt: { $first: '$createdAt' } } },
  ]);
  const lastOrderMap = new Map(lastOrders.map((item) => [item._id, item.lastOrderAt]));
  const usersWithLastOrder = users.map((user) => ({
    ...user,
    cartItemCount: getCartCount(user),
    lastOrderAt: lastOrderMap.get(user.telegramId) || null,
  }));

  res.json({
    users: usersWithLastOrder,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    windowIsOpen,
    windowOpenAt: windowOpenAt?.toISOString() || null,
  });
}));

router.get('/:telegramId', asyncHandler(async (req, res) => {
  const user = await User.findOne({ telegramId: req.params.telegramId });
  if (!user) throw appError('user_not_found');
  res.json(user);
}));

router.post('/', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.body.telegramId });
  const payload = await sanitizeUserPayload(req.body, existing);
  // telegramId береться з body тільки при створенні нового юзера
  if (!existing) payload.telegramId = req.body.telegramId;
  let user;
  if (existing) {
    user = await User.findByIdAndUpdate(existing._id, payload, { new: true, runValidators: true });
  } else {
    user = new User(payload);
    await user.save();
  }

  user = await syncUserWarehouseZone(user);
  res.status(existing ? 200 : 201).json(user);
}));

// Lightweight endpoint — only updates shopId + syncs deliveryGroupId from the shop.
// All writes (User, Order, PickingTask, lastSeller, history) run inside a single
// MongoDB transaction so a partial failure cannot leave User and Order pointing
// to different shops.
router.patch('/:telegramId/shop', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId });
  if (!existing) throw appError('user_not_found');

    const { shopId } = req.body;
    const oldShopId = existing.shopId ? String(existing.shopId) : '';
    const newShopId = shopId ? String(shopId) : '';

    // Special case: clearing the shop assignment (no destination shop).
    if (!newShopId) {
      if (!oldShopId) {
        return res.json(existing);
      }
      const session = await mongoose.connection.startSession();
      try {
        await session.withTransaction(async () => {
          const actor = req.telegramUser;
          const oldShop = await Shop.findById(oldShopId).session(session).lean();

          // Detach order from this seller? No — we leave it where it is and let
          // admins reassign it via /orders/:id/snapshot. We only detach the user.
          await User.updateOne(
            { telegramId: req.params.telegramId },
            {
              $set: {
                shopId: null,
                shopName: '',
                shopCity: '',
                deliveryGroupId: '',
                ...(existing.role === 'seller' ? { warehouseZone: '' } : {}),
                'cartState.reservedForGroupId': null,
              },
              $push: {
                history: {
                  at: new Date(),
                  by: String(actor.telegramId),
                  byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
                  byRole: actor.role,
                  action: 'shop_changed',
                  meta: { fromShop: oldShop?.name || null, toShop: null },
                },
              },
            },
            { session },
          );

          await Shop.findByIdAndUpdate(
            oldShopId,
            {
              lastSeller: {
                telegramId:   existing.telegramId,
                firstName:    existing.firstName  || '',
                lastName:     existing.lastName   || '',
                unassignedAt: new Date(),
              },
            },
            { session },
          );
        });
      } finally {
        session.endSession();
      }
      const refreshed = await User.findOne({ telegramId: req.params.telegramId });
      return res.json(refreshed);
    }

    const newShop = await Shop.findById(newShopId).populate('cityId', 'name').lean();
    if (!newShop) throw appError('shop_not_found');

    let migrationResult = null;
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        migrationResult = await migrateSellerShop({
          session,
          existingUser: existing,
          newShopFull: newShop,
          actor: req.telegramUser,
          reason: 'admin_reassigned_seller',
          resetCartItems: false,
          resetCartNavigation: false,
          clearCartReservation: true,
          pushHistory: true,
          updateLastSeller: true,
        });
      });
    } finally {
      session.endSession();
    }

    // Notify dashboards AFTER commit so listeners never see uncommitted state.
    if (migrationResult?.movedOrder) {
      try {
        const io = getIO();
        if (io) {
          const { prevGroupId, newGroupId } = migrationResult;
          if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
          if (newGroupId && newGroupId !== prevGroupId) {
            io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
            io.emit('delivery_groups_updated');
          }
          io.emit('user_order_updated', { buyerTelegramId: existing.telegramId });
        }
      } catch (emitErr) {
        console.warn('[PATCH /users/:telegramId/shop] socket emit failed:', emitErr?.message);
      }
    }

    res.json(migrationResult?.updatedUser || existing);
}));

router.patch('/:telegramId', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId });
  if (!existing) throw appError('user_not_found');

    const payload = await sanitizeUserPayload(req.body, existing);
    const oldShopId = existing.shopId ? String(existing.shopId) : '';
    const newShopId = payload.shopId ? String(payload.shopId) : '';
    const shopChanged = oldShopId !== newShopId;

    // If shop is changing AND the result is a real shop (not unassign), perform the
    // migration in a transaction so Order/PickingTask/User stay consistent. Other
    // payload fields are still applied via the standard update afterwards.
    let migrationResult = null;
    if (shopChanged && newShopId && payload.role === 'seller') {
      const newShop = await Shop.findById(newShopId).populate('cityId', 'name').lean();
      if (!newShop) throw appError('shop_not_found');

      const session = await mongoose.connection.startSession();
      try {
        await session.withTransaction(async () => {
          migrationResult = await migrateSellerShop({
            session,
            existingUser: existing,
            newShopFull: newShop,
            actor: req.telegramUser,
            reason: 'admin_user_patch',
            resetCartItems: false,
            resetCartNavigation: false,
            clearCartReservation: true,
            pushHistory: false, // history will be added by the role/shop diff logic below
            updateLastSeller: true,
          });
        });
      } finally {
        session.endSession();
      }
    }

    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      payload,
      { new: true, runValidators: true }
    );
    const updatedUser = await syncUserWarehouseZone(user);

    // Log shop and role changes
    const historyEntries = [];
    const actor = req.telegramUser;
    const actorMeta = {
      by: String(actor.telegramId),
      byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
      byRole: actor.role,
    };

    if (shopChanged) {
      const [oldShop, newShop, activeOrders] = await Promise.all([
        existing.shopId ? Shop.findById(existing.shopId, 'name').lean() : Promise.resolve(null),
        payload.shopId ? Shop.findById(payload.shopId, 'name').lean() : Promise.resolve(null),
        Order.countDocuments({ buyerTelegramId: existing.telegramId, status: { $in: ['new', 'in_progress'] } }),
      ]);
      historyEntries.push({
        at: new Date(),
        ...actorMeta,
        action: 'shop_changed',
        meta: {
          fromShop: oldShop?.name || null,
          toShop: newShop?.name || null,
          activeOrders,
          orderMoved: !!migrationResult?.movedOrder,
        },
      });
    }

    if (existing.role !== payload.role) {
      historyEntries.push({ at: new Date(), ...actorMeta, action: 'role_changed', meta: { from: existing.role, to: payload.role } });
    }

    if (historyEntries.length > 0) {
      await User.updateOne(
        { telegramId: req.params.telegramId },
        { $push: { history: { $each: historyEntries } } }
      );
    }

    // Notify dashboards if an order was moved during the migration
    if (migrationResult?.movedOrder) {
      try {
        const io = getIO();
        if (io) {
          const { prevGroupId, newGroupId } = migrationResult;
          if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
          if (newGroupId && newGroupId !== prevGroupId) {
            io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
            io.emit('delivery_groups_updated');
          }
          io.emit('user_order_updated', { buyerTelegramId: existing.telegramId });
        }
      } catch (emitErr) {
        console.warn('[PATCH /users/:telegramId] socket emit failed:', emitErr?.message);
      }
    }

    res.json(updatedUser);
}));

router.delete('/:telegramId', asyncHandler(async (req, res) => {
  // Перевірку «активних робіт» і саме видалення робимо в одній транзакції,
  // щоб у вікні між count і findOneAndDelete не з'явилося нове замовлення/
  // пакувальний таск (інакше отримаємо «висячі» посилання на видаленого user'а).
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const existing = await User.findOne({ telegramId: req.params.telegramId }).session(session);
      if (!existing) throw appError('user_not_found');

      const [activeOrders, activePickingTasks] = await Promise.all([
        Order.countDocuments({
          buyerTelegramId: existing.telegramId,
          status: { $in: ['new', 'in_progress'] },
        }).session(session),
        // Picking tasks reference orders by orderId — find any pending/locked task that
        // contains an order belonging to this buyer.
        (async () => {
          const buyerOrderIds = await Order.find(
            { buyerTelegramId: existing.telegramId },
            '_id',
          ).session(session).lean();
          if (!buyerOrderIds.length) return 0;
          return PickingTask.countDocuments({
            'items.orderId': { $in: buyerOrderIds.map((o) => o._id) },
            status: { $in: ['pending', 'locked'] },
          }).session(session);
        })(),
      ]);

      if (activeOrders > 0 || activePickingTasks > 0) {
        throw appError('user_has_active_work', { activeOrders, activePickingTasks });
      }

      const shopId = existing.shopId;
      await User.deleteOne({ _id: existing._id }, { session });

      // Зберігаємо «слід» продавця на магазині — у тій самій транзакції,
      // щоб або обидва записи з'явилися, або жодного.
      if (shopId) {
        await Shop.updateOne(
          { _id: shopId },
          {
            $set: {
              lastSeller: {
                telegramId: existing.telegramId,
                firstName: existing.firstName || '',
                lastName: existing.lastName || '',
                unassignedAt: new Date(),
              },
            },
          },
          { session },
        );
      }

      result = { message: 'Користувача видалено' };
    });

    return res.json(result);
  } finally {
    session.endSession();
  }
}));

module.exports = router;
