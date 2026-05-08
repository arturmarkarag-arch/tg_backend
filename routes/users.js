const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function syncDeliveryGroupMembership(telegramId, groupId) {
  // Remove user from all groups first
  await DeliveryGroup.updateMany(
    { members: telegramId },
    { $pull: { members: telegramId } }
  );
  // Add to the selected group if any
  if (groupId) {
    await DeliveryGroup.updateOne(
      { _id: groupId },
      { $addToSet: { members: telegramId } }
    );
  }
}

async function syncUserWarehouseZone(user) {
  if (user.role === 'seller') {
    const group = user.deliveryGroupId ? await DeliveryGroup.findById(user.deliveryGroupId).lean() : null;
    return await User.findByIdAndUpdate(user._id, { warehouseZone: group?.name || '' }, { new: true });
  }
  if (user.role !== 'warehouse') {
    return await User.findByIdAndUpdate(user._id, { warehouseZone: '' }, { new: true });
  }
  return user;
}

function sanitizeUserPayload(payload, existing = null) {
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
    data.shopNumber = payload.shopNumber;
    data.shopName = payload.shopName;
    data.shopAddress = payload.shopAddress;
    data.shopCity = payload.shopCity;
    data.deliveryGroupId = payload.deliveryGroupId;
  } else {
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

router.get('/', async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const roleFilter     = req.query.role || null;
  const groupFilter    = req.query.deliveryGroupId || null;
  const activityFilter = req.query.activityFilter || null; // 'no_cart' | 'no_order' | 'no_visit'

  const filter = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (groupFilter && groupFilter !== 'all') filter.deliveryGroupId = groupFilter;

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

  // Helper: compute cartItemCount from lean User doc
  const calcCartCount = (u) =>
    Object.values(u.miniAppState?.orderItems || {}).reduce((s, q) => s + (Number(q) || 0), 0);

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
      cartItemCount: calcCartCount(u),
      windowOrderQty: 0, // by definition — these users have no window orders
    }));
  } else if (activityFilter && windowIsOpen && windowOpenAt) {
    // no_cart / no_visit: push filter to MongoDB query — no in-memory scan
    if (activityFilter === 'no_cart') {
      // orderItemIds is kept in sync with orderItems keys by the mini-app state endpoint
      filter['$or'] = [
        { 'miniAppState.orderItemIds': { $exists: false } },
        { 'miniAppState.orderItemIds': { $size: 0 } },
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
    // Enrich with cart and order data for display
    const activityTids = users.map((u) => u.telegramId).filter(Boolean);
    const activityOrders = await Order.aggregate([
      { $match: { buyerTelegramId: { $in: activityTids }, createdAt: { $gte: windowOpenAt }, status: { $nin: ['cancelled', 'expired'] } } },
      { $unwind: '$items' },
      { $group: { _id: '$buyerTelegramId', totalQty: { $sum: '$items.quantity' } } },
    ]);
    const activityOrderQtyMap = new Map(activityOrders.map((o) => [o._id, o.totalQty]));
    users = users.map((u) => ({
      ...u,
      cartItemCount: calcCartCount(u),
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
        cartItemCount: calcCartCount(u),
        windowOrderQty: orderQtyMap.get(u.telegramId) || 0,
      }));
    }
  }

  const telegramIds = users.map((u) => u.telegramId).filter(Boolean);
  const lastOrders = await Order.aggregate([
    { $match: { buyerTelegramId: { $in: telegramIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$buyerTelegramId', lastOrderAt: { $first: '$createdAt' } } },
  ]);
  const lastOrderMap = new Map(lastOrders.map((item) => [item._id, item.lastOrderAt]));
  const usersWithLastOrder = users.map((user) => ({
    ...user,
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
});

router.get('/:telegramId', async (req, res) => {
  const user = await User.findOne({ telegramId: req.params.telegramId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/', async (req, res) => {
  const existing = await User.findOne({ telegramId: req.body.telegramId });
  const payload = sanitizeUserPayload(req.body, existing);
  // telegramId береться з body тільки при створенні нового юзера
  if (!existing) payload.telegramId = req.body.telegramId;
  let user;
  if (existing) {
    user = await User.findByIdAndUpdate(existing._id, payload, { new: true, runValidators: true });
  } else {
    user = new User(payload);
    await user.save();
  }

  await syncDeliveryGroupMembership(user.telegramId, user.deliveryGroupId);
  user = await syncUserWarehouseZone(user);
  res.status(existing ? 200 : 201).json(user);
});

router.patch('/:telegramId', async (req, res) => {
  try {
    const existing = await User.findOne({ telegramId: req.params.telegramId });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const payload = sanitizeUserPayload(req.body, existing);
    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      payload,
      { new: true, runValidators: true }
    );
    await syncDeliveryGroupMembership(user.telegramId, user.deliveryGroupId);
    const updatedUser = await syncUserWarehouseZone(user);
    res.json(updatedUser);
  } catch (err) {
    console.error('[PATCH /users/:telegramId]', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/:telegramId', async (req, res) => {
  const user = await User.findOneAndDelete({ telegramId: req.params.telegramId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Remove from all delivery groups
  await DeliveryGroup.updateMany(
    { members: user.telegramId },
    { $pull: { members: user.telegramId } }
  );
  res.json({ message: 'User deleted' });
});

module.exports = router;
