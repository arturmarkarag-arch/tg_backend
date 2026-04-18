const express = require('express');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');

const router = express.Router();

async function syncUsersWarehouseZone(group) {
  // Set warehouseZone for current members
  if (group.members?.length) {
    await User.updateMany(
      { telegramId: { $in: group.members } },
      { warehouseZone: group.name }
    );
  }
  // Clear warehouseZone for users removed from this group
  await User.updateMany(
    { warehouseZone: group.name, telegramId: { $nin: group.members || [] } },
    { warehouseZone: '' }
  );
}

router.get('/', async (req, res) => {
  const groups = await DeliveryGroup.find().sort({ createdAt: -1 });
  res.json(groups);
});

router.post('/', async (req, res) => {
  const { name, dayOfWeek } = req.body;
  if (!name || dayOfWeek === undefined) {
    return res.status(400).json({ error: 'name and dayOfWeek are required' });
  }
  const group = new DeliveryGroup({ name, dayOfWeek, members: req.body.members || [], telegramChatId: req.body.telegramChatId || '' });
  await group.save();
  await syncUsersWarehouseZone(group);
  res.status(201).json(group);
});

router.patch('/:id', async (req, res) => {
  const oldGroup = await DeliveryGroup.findById(req.params.id);
  if (!oldGroup) return res.status(404).json({ error: 'Group not found' });

  const group = await DeliveryGroup.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  // Clear warehouseZone for members removed from the group
  const removedMembers = (oldGroup.members || []).filter((m) => !(group.members || []).includes(m));
  if (removedMembers.length) {
    await User.updateMany(
      { telegramId: { $in: removedMembers }, warehouseZone: oldGroup.name },
      { warehouseZone: '' }
    );
  }
  await syncUsersWarehouseZone(group);
  res.json(group);
});

router.delete('/:id', async (req, res) => {
  const group = await DeliveryGroup.findByIdAndDelete(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  // Clear warehouseZone for all members of this group
  if (group.members?.length) {
    await User.updateMany(
      { telegramId: { $in: group.members }, warehouseZone: group.name },
      { warehouseZone: '' }
    );
  }
  res.json({ message: 'Group deleted' });
});

/**
 * POST /api/delivery-groups/:id/broadcast
 * Send all active products to all members of the specified delivery group.
 */
router.post('/:id/broadcast', async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.members?.length) {
    return res.status(400).json({ error: 'Група не має учасників' });
  }

  try {
    const { startBroadcast } = require('../broadcast');
    const result = await startBroadcast({
      productFilter: { status: 'active' },
      recipientIds: group.members,
      addLabels: true,
    });
    res.json({ message: `Розсилку розпочато для групи "${group.name}"`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
