const express = require('express');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const Order = require('../models/Order');
const Shop = require('../models/Shop');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');
const {
  isOrderingOpen,
  getWindowDescription,
  getCurrentOrderingSessionId,
  getOrderingWindowOpenAt,
} = require('../utils/orderingSchedule');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');

const router = express.Router();

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

  // Warehouse is always unrestricted. Admin without a shopId is also unrestricted.
  // Admin WITH a shopId goes through the same ordering window check as a seller.
  if (user.role === 'warehouse' || (user.role === 'admin' && !user.shopId)) {
    return res.json({ isOpen: true, message: 'Персонал складу — без обмежень' });
  }

  if (!user.shopId) {
    return res.json({
      isOpen: false,
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
    });
  }

  const shop = await Shop.findById(user.shopId).lean();
  if (!shop || !shop.deliveryGroupId) {
    return res.json({
      isOpen: false,
      message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
    });
  }

  const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
  if (!group) {
    return res.json({
      isOpen: false,
      message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
    });
  }

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const window = getWindowDescription(group.dayOfWeek, schedule);
  const sessionOpenAt = getOrderingWindowOpenAt(group.dayOfWeek, schedule).toISOString();
  return res.json({ ...status, groupName: group.name, window, sessionOpenAt });
});

router.get('/summary', async (req, res) => {
  const groups = await DeliveryGroup.find().select('name dayOfWeek').lean();

  // Кількість активних магазинів по кожній групі
  const shopCounts = await Shop.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
  ]);
  const shopCountMap = Object.fromEntries(shopCounts.map(({ _id, count }) => [String(_id), count]));

  // Кількість продавців по кожній групі (через Shop)
  const sellerCounts = await User.aggregate([
    { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
    { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
    { $unwind: '$shop' },
    { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
  ]);
  const sellerCountMap = Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count]));

  const result = groups.map((g) => ({
    _id: g._id,
    name: g.name,
    dayOfWeek: g.dayOfWeek,
    shopCount: shopCountMap[String(g._id)] || 0,
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

/**
 * GET /api/delivery-groups/:groupId/shop-status
 * Returns per-shop cart and ordered item counts for the current ordering session.
 */
router.get('/:groupId/shop-status', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.groupId).lean();
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);

  const shops = await Shop.find({ deliveryGroupId: String(group._id), isActive: true })
    .select('name cityId cartState')
    .populate('cityId', 'name')
    .lean();

  const shopIds = shops.map((s) => s._id);

  const orders = await Order.find({
    'buyerSnapshot.shopId': { $in: shopIds },
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('buyerSnapshot.shopId items').lean();

  const orderedByShop = {};
  for (const order of orders) {
    const shopId = String(order.buyerSnapshot?.shopId || '');
    if (!shopId) continue;
    if (!orderedByShop[shopId]) orderedByShop[shopId] = new Set();
    for (const item of order.items || []) {
      if (item.productId) orderedByShop[shopId].add(String(item.productId));
    }
  }

  const shopStatuses = shops.map((shop) => {
    const cartItems = shop.cartState?.orderItems || {};
    const cartItemCount = Object.keys(cartItems).length;
    const shopId = String(shop._id);
    return {
      shopId,
      shopName: shop.name,
      shopCity: shop.cityId?.name || '',
      cartItemCount,
      orderedItemCount: orderedByShop[shopId]?.size || 0,
    };
  });

  shopStatuses.sort((a, b) => String(a.shopCity || '').localeCompare(String(b.shopCity || ''), 'uk') || String(a.shopName || '').localeCompare(String(b.shopName || ''), 'uk'));

  res.json({
    groupId: String(group._id),
    groupName: group.name,
    isOpen: status.isOpen,
    currentSessionId,
    shops: shopStatuses,
  });
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

  const [shopCounts, sellerCounts] = await Promise.all([
    Shop.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
    ]),
    User.aggregate([
      { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
      { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
      { $unwind: '$shop' },
      { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
    ]),
  ]);
  const shopCountMap = Object.fromEntries(shopCounts.map(({ _id, count }) => [String(_id), count]));
  const sellerCountMap = Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count]));

  const result = groups.map((g) => ({
    ...g,
    isOpen: isOrderingOpen(g.dayOfWeek, schedule).isOpen,
    shopCount: shopCountMap[String(g._id)] || 0,
    sellerCount: sellerCountMap[String(g._id)] || 0,
  }));
  res.json(result);
});

router.post('/', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const { name, dayOfWeek } = req.body;
  if (!name || dayOfWeek === undefined) {
    return res.status(400).json({ error: 'name and dayOfWeek are required' });
  }

  const group = new DeliveryGroup({ name, dayOfWeek });
  await group.save();
  res.status(201).json(group);
});

router.patch('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const { name, dayOfWeek } = req.body;
  if (name !== undefined) group.name = name;
  if (dayOfWeek !== undefined) group.dayOfWeek = dayOfWeek;

  await group.save();
  res.json(group);
});

router.delete('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const shopCount = await Shop.countDocuments({ deliveryGroupId: String(group._id), isActive: true });
  if (shopCount > 0) {
    return res.status(400).json({ error: `Не можна видалити групу: ${shopCount} магазин(ів) прив'язано` });
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
