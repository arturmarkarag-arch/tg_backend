const express = require('express');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const Order = require('../models/Order');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const {
  isOrderingOpen,
  getWindowDescription,
  getCurrentOrderingSessionId,
  getOrderingWindowOpenAt,
} = require('../utils/orderingSchedule');
const AppSetting = require('../models/AppSetting');

const ORDERING_SCHEDULE_KEY = 'ordering.schedule';
const ORDERING_SCHEDULE_DEFAULTS = { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };
async function getOrderingSchedule() {
  const saved = await AppSetting.findOne({ key: ORDERING_SCHEDULE_KEY }).lean();
  return { ...ORDERING_SCHEDULE_DEFAULTS, ...(saved?.value || {}) };
}

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

function buildDeliveryGroupSessionSummary(group, schedule, ordersByGroup) {
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
  const sessionOpenAt = getOrderingWindowOpenAt(group.dayOfWeek, schedule);
  const orders = ordersByGroup[String(group._id)] || [];
  const summary = orders.reduce(
    (acc, order) => {
      if (order.orderingSessionId === currentSessionId) {
        acc.activeCount += 1;
      } else {
        acc.staleCount += 1;
      }
      return acc;
    },
    { activeCount: 0, staleCount: 0 }
  );

  return {
    groupId: String(group._id),
    groupName: group.name,
    dayOfWeek: group.dayOfWeek,
    isOpen: status.isOpen,
    statusMessage: status.message,
    sessionOpenAt: sessionOpenAt.toISOString(),
    currentSessionId,
    activeCount: summary.activeCount,
    staleCount: summary.staleCount,
  };
}

/**
 * GET /api/delivery-groups/ordering-status
 * Returns ordering window status for the current user's delivery group.
 * Admin/warehouse always get isOpen: true.
 */
router.get('/ordering-status', telegramAuth, async (req, res) => {
  const user = req.telegramUser;

  if (user.role === 'admin' || user.role === 'warehouse') {
    return res.json({ isOpen: true, message: 'Персонал складу — без обмежень' });
  }

  if (!user.deliveryGroupId) {
    return res.json({
      isOpen: false,
      message: 'Вас не призначено до жодної групи доставки. Зверніться до адміністратора.',
    });
  }

  const group = await DeliveryGroup.findById(user.deliveryGroupId).lean();
  if (!group) {
    return res.json({
      isOpen: false,
      message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
    });
  }

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const window = getWindowDescription(group.dayOfWeek, schedule);
  return res.json({ ...status, groupName: group.name, window });
});

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

router.get('/session-summaries', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const groups = await DeliveryGroup.find().lean();
  const schedule = await getOrderingSchedule();
  const groupIds = groups.map((group) => String(group._id));

  const orders = await Order.find({
    'buyerSnapshot.deliveryGroupId': { $in: groupIds },
    status: { $in: ['new', 'in_progress'] },
  })
    .select('buyerSnapshot.deliveryGroupId orderingSessionId')
    .lean();

  const ordersByGroup = orders.reduce((acc, order) => {
    const groupId = String(order.buyerSnapshot.deliveryGroupId || '');
    if (!groupId) return acc;
    if (!acc[groupId]) acc[groupId] = [];
    acc[groupId].push(order);
    return acc;
  }, {});

  const summaries = groups.map((group) => buildDeliveryGroupSessionSummary(group, schedule, ordersByGroup));
  summaries.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.groupName || '').localeCompare(String(b.groupName || ''));
  });
  res.json(summaries);
});

router.post('/:id/close-ordering-session', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id).lean();
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);

  const staleOrderFilter = {
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
  };
  if (status.isOpen) {
    staleOrderFilter.orderingSessionId = { $ne: currentSessionId };
  }

  const result = await Order.updateMany(staleOrderFilter, { status: 'expired' });
  const expiredCount = result.modifiedCount ?? result.nModified ?? 0;

  res.json({
    message: expiredCount > 0
      ? `Старі замовлення з попередньої сесії закрито: ${expiredCount}.`
      : 'Старих замовлень для закриття не знайдено.',
    expiredCount,
  });
});

router.get('/', async (req, res) => {
  const groups = await DeliveryGroup.find().lean();
  groups.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const schedule = await getOrderingSchedule();
  const result = groups.map((g) => ({
    ...g,
    isOpen: isOrderingOpen(g.dayOfWeek, schedule).isOpen,
  }));
  res.json(result);
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
