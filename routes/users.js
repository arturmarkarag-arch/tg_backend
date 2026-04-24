const express = require('express');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function syncDeliveryGroupMembership(telegramId, groupName) {
  // Remove user from all groups first
  await DeliveryGroup.updateMany(
    { members: telegramId },
    { $pull: { members: telegramId } }
  );
  // Add to the selected group if any
  if (groupName) {
    await DeliveryGroup.updateOne(
      { name: groupName },
      { $addToSet: { members: telegramId } }
    );
  }
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
  let user;
  if (existing) {
    user = await User.findByIdAndUpdate(existing._id, req.body, { new: true, runValidators: true });
  } else {
    user = new User(req.body);
    await user.save();
  }

  await syncDeliveryGroupMembership(user.telegramId, user.warehouseZone);
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
