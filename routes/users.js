const express = require('express');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function syncDeliveryGroupMembership(telegramId, groupId, groupId2) {
  // Remove user from all groups first
  await DeliveryGroup.updateMany(
    { members: telegramId },
    { $pull: { members: telegramId } }
  );
  // Add to the first group if any
  if (groupId) {
    await DeliveryGroup.updateOne(
      { _id: groupId },
      { $addToSet: { members: telegramId } }
    );
  }
  // Add to the second group if any (and it's different from the first)
  if (groupId2 && groupId2 !== groupId) {
    await DeliveryGroup.updateOne(
      { _id: groupId2 },
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
    deliveryGroupId2: payload.deliveryGroupId2 || '',
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
  const users = await User.find().sort({ createdAt: -1 });
  res.json(users);
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

  await syncDeliveryGroupMembership(user.telegramId, user.deliveryGroupId, user.deliveryGroupId2);
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
