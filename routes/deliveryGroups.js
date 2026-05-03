const express = require('express');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();

async function syncUsersDeliveryGroupId(group) {
  // Set deliveryGroupId for current members
  if (group.members?.length) {
    await User.updateMany(
      { telegramId: { $in: group.members } },
      { deliveryGroupId: group._id, warehouseZone: group.name }
    );
  }
  // Clear deliveryGroupId for users removed from this group
  await User.updateMany(
    { deliveryGroupId: group._id, telegramId: { $nin: group.members || [] } },
    { deliveryGroupId: '', warehouseZone: '' }
  );
}

router.get('/summary', async (req, res) => {
  const groups = await DeliveryGroup.find().select('name dayOfWeek members').lean();

  // Count actual registered sellers per group (same query the commit route uses)
  const sellerCounts = await User.aggregate([
    { $match: { role: 'seller', deliveryGroupId: { $ne: '' } } },
    { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
  ]);
  const sellerCountMap = Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count]));

  const result = groups.map((g) => ({
    _id: g._id,
    name: g.name,
    dayOfWeek: g.dayOfWeek,
    shopCount: g.members?.length || 0,
    sellerCount: sellerCountMap[String(g._id)] || 0,
  }));
  result.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  res.json(result);
});

router.get('/', async (req, res) => {
  const groups = await DeliveryGroup.find().lean();
  groups.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  res.json(groups);
});

router.post('/', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const { name, dayOfWeek } = req.body;
  if (!name || dayOfWeek === undefined) {
    return res.status(400).json({ error: 'name and dayOfWeek are required' });
  }

  const members = Array.isArray(req.body.members)
    ? req.body.members.map((id) => String(id).trim()).filter(Boolean)
    : [];

  let validMembers = [];
  if (members.length > 0) {
    validMembers = await User.find({ telegramId: { $in: members } }).distinct('telegramId');
    const invalidMembers = members.filter((id) => !validMembers.includes(id));
    if (invalidMembers.length > 0) {
      return res.status(400).json({ error: `Invalid member telegramId(s): ${invalidMembers.join(', ')}` });
    }
  }

  const group = new DeliveryGroup({
    name,
    dayOfWeek,
    members: validMembers,
  });
  await group.save();
  await syncUsersDeliveryGroupId(group);
  res.status(201).json(group);
});

router.patch('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const oldGroup = await DeliveryGroup.findById(req.params.id);
  if (!oldGroup) return res.status(404).json({ error: 'Group not found' });

  const body = { ...req.body };
  if (body.members !== undefined) {
    if (!Array.isArray(body.members)) {
      return res.status(400).json({ error: 'members must be an array of telegramId strings' });
    }
    const members = body.members.map((id) => String(id).trim()).filter(Boolean);
    const validMembers = await User.find({ telegramId: { $in: members } }).distinct('telegramId');
    const invalidMembers = members.filter((id) => !validMembers.includes(id));
    if (invalidMembers.length > 0) {
      return res.status(400).json({ error: `Invalid member telegramId(s): ${invalidMembers.join(', ')}` });
    }
    body.members = validMembers;
  }

  const group = await DeliveryGroup.findByIdAndUpdate(req.params.id, body, {
    new: true,
    runValidators: true,
  });

  const removedMembers = (oldGroup.members || []).filter((m) => !(group.members || []).includes(m));
  if (removedMembers.length) {
    await User.updateMany(
      { telegramId: { $in: removedMembers }, deliveryGroupId: oldGroup._id },
      { deliveryGroupId: '', warehouseZone: '' }
    );
  }
  await syncUsersDeliveryGroupId(group);
  res.json(group);
});

router.delete('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.members?.length) {
    return res.status(400).json({ error: 'Cannot delete a delivery group with members' });
  }

  await DeliveryGroup.findByIdAndDelete(req.params.id);
  res.json({ message: 'Group deleted' });
});

/**
 * POST /api/delivery-groups/:id/broadcast
 * Send all active products to all members of the specified delivery group.
 */
/*
router.post('/:id/broadcast', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
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
*/

module.exports = router;
