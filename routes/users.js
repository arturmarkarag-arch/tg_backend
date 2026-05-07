const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

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
    telegramId: payload.telegramId,
    role,
    firstName: payload.firstName,
    lastName: payload.lastName,
    phoneNumber: payload.phoneNumber,
    botBlocked: payload.botBlocked,
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
  const roleFilter  = req.query.role || null;
  const groupFilter = req.query.deliveryGroupId || null;

  const filter = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (groupFilter && groupFilter !== 'all') filter.deliveryGroupId = groupFilter;

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

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
    res.status(500).json({ error: err.message });
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
