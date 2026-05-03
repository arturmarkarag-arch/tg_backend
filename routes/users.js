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

function sanitizeUserPayload(payload, existing = null) {
  const role = payload.role ?? existing?.role ?? 'seller';
  const data = {
    telegramId: payload.telegramId,
    role,
    firstName: payload.firstName,
    lastName: payload.lastName,
    phoneNumber: payload.phoneNumber,
    shopNumber: payload.shopNumber,
    shopName: payload.shopName,
    shopAddress: payload.shopAddress,
    shopCity: payload.shopCity,
    deliveryGroupId: payload.deliveryGroupId,
    warehouseZone: payload.warehouseZone,
    botBlocked: payload.botBlocked,
  };

  if (role === 'warehouse') {
    data.isWarehouseManager = Boolean(payload.isWarehouseManager);
  } else {
    data.isWarehouseManager = false;
  }

  return data;
}

router.get('/', async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).lean();
  const telegramIds = users.map((user) => user.telegramId).filter(Boolean);
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
  res.json(usersWithLastOrder);
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
  res.status(existing ? 200 : 201).json(user);
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
