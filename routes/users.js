const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const PickingTask = require('../models/PickingTask');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { migrateSellerShop } = require('../services/migrateSellerShop');
const { appError, asyncHandler } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { invalidateShop } = require('../utils/modelCache');
const { getIO } = require('../socket');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function sanitizeUserPayload(payload, existing = null) {
  const role = payload.role ?? existing?.role ?? 'seller';
  const data = { role };

  // Only write fields that were explicitly provided — undefined means "not in payload, leave as-is"
  if (payload.firstName  !== undefined) data.firstName  = payload.firstName;
  if (payload.lastName   !== undefined) data.lastName   = payload.lastName;
  if (payload.phoneNumber !== undefined) data.phoneNumber = payload.phoneNumber;
  if (payload.botBlocked !== undefined && payload.botBlocked !== null) {
    data.botBlocked = Boolean(payload.botBlocked === 'false' ? false : payload.botBlocked);
  }

  // Seller-specific fields. deliveryGroupId + warehouseZone are derived from the shop
  // in the same payload so a single atomic update covers all three values.
  if (role === 'seller') {
    if (payload.shopId !== undefined) data.shopId = payload.shopId || null;
    if (payload.shopNumber !== undefined) data.shopNumber = payload.shopNumber;
    const resolveShopId = data.shopId !== undefined ? data.shopId : existing?.shopId;
    if (resolveShopId) {
      const shop = await Shop.findById(resolveShopId).lean();
      data.deliveryGroupId = shop?.deliveryGroupId || '';
      if (shop?.deliveryGroupId) {
        const grp = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
        data.warehouseZone = grp?.name || '';
      } else {
        data.warehouseZone = '';
      }
    } else {
      data.deliveryGroupId = '';
      data.warehouseZone = '';
    }
  } else {
    data.shopId = null;
    data.shopNumber = '';
    data.deliveryGroupId = '';
  }

  // Warehouse-specific fields
  if (role === 'warehouse') {
    if (payload.isWarehouseManager !== undefined) data.isWarehouseManager = Boolean(payload.isWarehouseManager);
    if (payload.warehouseZone !== undefined) data.warehouseZone = payload.warehouseZone;
  } else if (role !== 'seller') {
    data.isWarehouseManager = false;
    data.isOnShift = false;
    data.shiftZone = { startBlock: null, endBlock: null };
    data.warehouseZone = '';
  } else {
    // role === 'seller' — clear warehouse-only flags
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
  const cityFilter     = req.query.cityId || null; // Filter by City._id, resolved to shopIds
  const searchQuery    = req.query.search?.trim() || null;
  const activityFilter = req.query.activityFilter || null; // 'no_cart' | 'no_order' | 'no_visit'

  const filter = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (groupFilter && groupFilter !== 'all') filter.deliveryGroupId = groupFilter;

  // City filter: resolve cityId → shops in that city → filter by shopId
  if (cityFilter && cityFilter !== 'all') {
    const cityShops = await Shop.find({ cityId: cityFilter }, '_id').lean();
    filter.shopId = { $in: cityShops.map((s) => s._id) };
  }

  // Text search across name, phone, telegramId
  if (searchQuery) {
    const re = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter['$or'] = [
      { firstName: re },
      { lastName: re },
      { phoneNumber: re },
      { telegramId: searchQuery },
    ];
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
      windowOrderQty: 0,
    }));
  } else if (activityFilter && windowIsOpen && windowOpenAt) {
    if (activityFilter === 'no_cart') {
      // cartState lives on User — exclude sellers who already have cart items
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

  // Compute cartItemCount from User.cartState (cartState lives on User, not Shop)
  const getCartCount = (u) => {
    const items = u.cartState?.orderItems;
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
  const telegramId = req.body.telegramId;
  if (!telegramId) throw appError('auth_telegram_id_missing');

  const existing = await User.findOne({ telegramId });
  const payload = await sanitizeUserPayload(req.body, existing);

  if (existing) {
    const user = await User.findByIdAndUpdate(existing._id, payload, { new: true, runValidators: true });
    return res.status(200).json(user);
  }

  payload.telegramId = telegramId;
  try {
    const user = await User.create(payload);
    return res.status(201).json(user);
  } catch (err) {
    // Race: another request created the same telegramId between findOne and create.
    if (err && err.code === 11000) {
      throw appError('user_telegram_id_taken', { telegramId });
    }
    throw err;
  }
}));

// Lightweight endpoint — updates shopId using migrateSellerShop for full consistency
router.patch('/:telegramId/shop', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId });
  if (!existing) throw appError('user_not_found');
  if (!['seller', 'admin'].includes(existing.role)) {
    throw appError('validation_failed', { field: 'role' });
  }

  const { shopId } = req.body;
  if (!shopId) {
    // Unassign from shop — simple update, no migration needed
    const user = await withLock(`user:${req.params.telegramId}:shop`, async () => {
      const session = await mongoose.connection.startSession();
      try {
        let updated;
        await session.withTransaction(async () => {
          const now = new Date();
          const oldShopId = existing.shopId ? String(existing.shopId) : null;

          updated = await User.findOneAndUpdate(
            { telegramId: req.params.telegramId },
            { shopId: null, deliveryGroupId: '' },
            { new: true, session }
          );

          if (oldShopId) {
            await Shop.findByIdAndUpdate(
              oldShopId,
              {
                lastSellerChangedAt: now,
                lastSeller: {
                  telegramId: existing.telegramId,
                  firstName: existing.firstName || '',
                  lastName: existing.lastName || '',
                  unassignedAt: now,
                },
              },
              { session }
            );
          }
        });
        return updated;
      } finally {
        session.endSession();
      }
    });
    if (existing.shopId) await invalidateShop(existing.shopId);
    return res.json(user);
  }

  const newShopFull = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!newShopFull) throw appError('shop_not_found');

  const actor = req.telegramUser || { telegramId: 'admin', firstName: 'Admin', lastName: '', role: 'admin' };

  const result = await withLock(`user:${req.params.telegramId}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        // Re-read inside the lock so two queued admins do not both act on a stale snapshot
        const freshExisting = await User.findOne({ telegramId: req.params.telegramId }).session(session).lean();
        if (!freshExisting) throw appError('user_not_found');
        out = await migrateSellerShop({
          session,
          existingUser: freshExisting,
          newShopFull,
          actor,
          reason: 'admin_shop_assignment',
        });
      });
      return out;
    } finally {
      session.endSession();
    }
  });

  const io = getIO();
  if (result.movedOrder) {
    if (result.prevGroupId) io.to(`picking_group_${result.prevGroupId}`).emit('shop_status_changed', { groupId: result.prevGroupId });
    if (result.newGroupId && result.newGroupId !== result.prevGroupId) {
      io.to(`picking_group_${result.newGroupId}`).emit('shop_status_changed', { groupId: result.newGroupId });
    }
    io.emit('user_order_updated', { buyerTelegramId: existing.telegramId });
  }

  if (existing.shopId) await invalidateShop(existing.shopId);
  await invalidateShop(newShopFull._id);

  res.json(result.updatedUser);
}));

router.patch('/:telegramId', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId });
  if (!existing) throw appError('user_not_found');

  const payload = await sanitizeUserPayload(req.body, existing);

  // If shopId is changing for a seller, use migrateSellerShop for full consistency
  const oldShopId = existing.shopId ? String(existing.shopId) : null;
  const newShopId = payload.shopId ? String(payload.shopId) : null;
  const shopChanging = payload.shopId !== undefined && newShopId !== oldShopId && newShopId;

  if (shopChanging && ['seller', 'admin'].includes(payload.role ?? existing.role)) {
    const newShopFull = await Shop.findById(payload.shopId).populate('cityId', 'name').lean();
    if (!newShopFull) throw appError('shop_not_found');

    const actor = req.telegramUser || { telegramId: 'admin', firstName: 'Admin', lastName: '', role: 'admin' };
    // Apply non-shop fields first, then run migration for shop-related fields
    const nonShopPayload = { ...payload };
    delete nonShopPayload.shopId;
    delete nonShopPayload.deliveryGroupId;

    const result = await withLock(`user:${req.params.telegramId}:shop`, async () => {
      const session = await mongoose.connection.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          if (Object.keys(nonShopPayload).length > 0) {
            await User.findOneAndUpdate({ telegramId: req.params.telegramId }, nonShopPayload, { session });
          }
          const freshExisting = await User.findOne({ telegramId: req.params.telegramId }).session(session).lean();
          if (!freshExisting) throw appError('user_not_found');
          out = await migrateSellerShop({
            session,
            existingUser: freshExisting,
            newShopFull,
            actor,
            reason: 'admin_general_patch',
          });
        });
        return out;
      } finally {
        session.endSession();
      }
    });

    const io = getIO();
    if (result.movedOrder) {
      if (result.prevGroupId) io.to(`picking_group_${result.prevGroupId}`).emit('shop_status_changed', { groupId: result.prevGroupId });
      if (result.newGroupId && result.newGroupId !== result.prevGroupId) {
        io.to(`picking_group_${result.newGroupId}`).emit('shop_status_changed', { groupId: result.newGroupId });
      }
      io.emit('user_order_updated', { buyerTelegramId: existing.telegramId });
    }
    if (oldShopId) await invalidateShop(oldShopId);
    await invalidateShop(newShopFull._id);
    return res.json(result.updatedUser);
  }

  const user = await User.findOneAndUpdate(
    { telegramId: req.params.telegramId },
    payload,
    { new: true, runValidators: true }
  );
  res.json(user);
}));

router.delete('/:telegramId', asyncHandler(async (req, res) => {
  const user = await User.findOne({ telegramId: req.params.telegramId });
  if (!user) throw appError('user_not_found');

  // Block deletion if user has active orders or picking tasks
  const [activeOrders, activePickingTasks] = await Promise.all([
    Order.countDocuments({ buyerTelegramId: user.telegramId, status: { $in: ['new', 'in_progress'] } }),
    PickingTask.countDocuments({ assignedTo: user.telegramId, status: { $in: ['pending', 'locked'] } }),
  ]);
  if (activeOrders > 0 || activePickingTasks > 0) {
    throw appError('user_has_active_work', { activeOrders, activePickingTasks });
  }

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await User.findOneAndDelete({ telegramId: req.params.telegramId }, { session });

      // Update the shop's lastSeller snapshot on removal
      if (user.shopId) {
        await Shop.findByIdAndUpdate(
          user.shopId,
          {
            lastSellerChangedAt: new Date(),
            lastSeller: {
              telegramId: user.telegramId,
              firstName: user.firstName || '',
              lastName: user.lastName || '',
              unassignedAt: new Date(),
            },
          },
          { session }
        );
      }
    });
  } finally {
    session.endSession();
  }

  if (user.shopId) await invalidateShop(user.shopId);
  res.json({ message: 'Користувача видалено' });
}));

module.exports = router;
