const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
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
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');

const router = express.Router();

function buildDeliveryGroupSessionSummary(group, schedule, ordersByGroup) {
  const normalizedGroup = normalizeDeliveryGroup(group);
  const status = isOrderingOpen(normalizedGroup.dayOfWeek, schedule);
  const currentSessionId = getCurrentOrderingSessionId(String(normalizedGroup._id), normalizedGroup.dayOfWeek, schedule);
  const sessionOpenAt = getOrderingWindowOpenAt(normalizedGroup.dayOfWeek, schedule);
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
    groupId: String(normalizedGroup._id),
    groupName: normalizedGroup.name,
    dayOfWeek: normalizedGroup.dayOfWeek,
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

  const transferEvent = Array.isArray(user.history)
    ? [...user.history].reverse().find((entry) =>
        entry.action === 'shop_changed'
        && entry.meta?.fromShop
        && entry.meta?.toShop
        && ['admin', 'warehouse'].includes(entry.byRole)
      )
    : null;
  const transferNote = transferEvent
    ? `Вас переміщено з магазину "${transferEvent.meta.fromShop}" на магазин "${transferEvent.meta.toShop}", ви робите замовлення на інший магазин. Якщо ви нічого не знаєте про це, зверніться до вашого менеджера або в групу в телеграмі!`
    : null;
  const transferNoteId = transferEvent
    ? `shop_changed:${transferEvent.at ? new Date(transferEvent.at).toISOString() : 'unknown'}`
    : null;
  const transferPayload = transferNote ? { note: transferNote, transferNoteId } : {};

  // Warehouse is always unrestricted. Admin without a shopId is also unrestricted.
  // Admin WITH a shopId goes through the same ordering window check as a seller.
  if (user.role === 'warehouse' || (user.role === 'admin' && !user.shopId)) {
    return res.json({ isOpen: true, ...transferPayload });
  }

  if (!user.shopId) {
    return res.json({
      isOpen: false,
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const shop = await Shop.findById(user.shopId).lean();
  if (!shop || !shop.deliveryGroupId) {
    return res.json({
      isOpen: false,
      message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
  if (!group) {
    return res.json({
      isOpen: false,
      message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const window = getWindowDescription(group.dayOfWeek, schedule);
  const sessionOpenAt = getOrderingWindowOpenAt(group.dayOfWeek, schedule).toISOString();
  return res.json({ ...status, groupName: group.name, window, sessionOpenAt, ...transferPayload });
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

  const normalizedGroups = groups.map(normalizeDeliveryGroup);
  const result = normalizedGroups.map((g) => ({
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
router.get('/:groupId/shop-status', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(req.params.groupId).lean());
  if (!group) throw appError('group_not_found');

  const schedule = await getOrderingSchedule();
  const status = isOrderingOpen(group.dayOfWeek, schedule);
  const currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);

  const shops = await Shop.find({ deliveryGroupId: String(group._id), isActive: true })
    .select('name cityId')
    .populate('cityId', 'name')
    .lean();

  const shopIds = shops.map((s) => s._id);

  const orders = await Order.find({
    shopId: { $in: shopIds },
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('buyerSnapshot shopId buyerTelegramId items orderNumber _id createdAt history').lean();

  const staleOrders = await Order.find({
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: { $ne: currentSessionId },
  }).select('buyerSnapshot buyerTelegramId items orderNumber _id createdAt orderingSessionId').lean();

  const sellers = await User.find({ role: { $in: ['seller', 'admin'] }, shopId: { $in: shopIds } })
    .select('shopId firstName lastName telegramId cartState role')
    .lean();
  // Collect ALL sellers per shop with cart status
  const sellersByShop = {};
  for (const seller of sellers) {
    const sid = String(seller.shopId);
    if (!sellersByShop[sid]) sellersByShop[sid] = [];
    const items = seller.cartState?.orderItems;
    const itemObj = items instanceof Map ? Object.fromEntries(items) : (items || {});
    sellersByShop[sid].push({
      name: [seller.firstName, seller.lastName].filter(Boolean).join(' ') || String(seller.telegramId),
      telegramId: String(seller.telegramId),
      role: seller.role,
      hasCart: Object.keys(itemObj).length > 0,
    });
  }

  // Build buyer name+role lookup from all unique buyerTelegramIds in orders
  const buyerTgIds = [...new Set([...orders, ...staleOrders].map((o) => o.buyerTelegramId).filter(Boolean))];
  const buyers = await User.find({ telegramId: { $in: buyerTgIds } })
    .select('telegramId firstName lastName role')
    .lean();
  const buyerInfoById = {};
  for (const b of buyers) {
    buyerInfoById[String(b.telegramId)] = {
      name: [b.firstName, b.lastName].filter(Boolean).join(' ') || b.telegramId,
      role: b.role,
    };
  }

  // Group orders by shopId for conflict detection
  const ordersByShop = {};
  const orderedByShop = {};
  for (const order of orders) {
    const shopId = String(order.shopId || order.buyerSnapshot?.shopId || '');
    if (!shopId) continue;
    if (!ordersByShop[shopId]) ordersByShop[shopId] = [];
    // Flag any order that was ever reassigned to a different shop (regardless of who did it).
    const reassignEntry = (order.history || []).slice().reverse().find((h) => h.action === 'shop_reassigned');
    const wasReassigned = !!reassignEntry;
    ordersByShop[shopId].push({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: order.buyerTelegramId,
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      buyerRole: buyerInfoById[String(order.buyerTelegramId)]?.role || 'seller',
      itemCount: (order.items || []).filter((i) => !i.cancelled).length,
      createdAt: order.createdAt,
      wasReassigned,
      fromShopName: wasReassigned ? (reassignEntry?.meta?.from?.shopName || null) : null,
    });
    if (!orderedByShop[shopId]) orderedByShop[shopId] = new Set();
    for (const item of order.items || []) {
      if (item.productId && !item.cancelled) orderedByShop[shopId].add(String(item.productId));
    }
  }

  // Build per-shop seller cart items map (cartState is now per-user, not per-shop)
  const cartItemsByShop = {};
  for (const seller of sellers) {
    const sid = String(seller.shopId);
    const items = seller.cartState?.orderItems;
    if (!items) continue;
    const itemObj = items instanceof Map ? Object.fromEntries(items) : items;
    cartItemsByShop[sid] = (cartItemsByShop[sid] || 0) + Object.keys(itemObj).length;
  }

  // Build set of telegramIds that placed an order per shop in this session
  const orderedBuyersByShop = {};
  for (const order of orders) {
    const sid = String(order.shopId || '');
    if (!sid || !order.buyerTelegramId) continue;
    if (!orderedBuyersByShop[sid]) orderedBuyersByShop[sid] = new Set();
    orderedBuyersByShop[sid].add(String(order.buyerTelegramId));
  }

  const shopStatuses = shops.map((shop) => {
    const shopId = String(shop._id);
    const cartItemCount = cartItemsByShop[shopId] || 0;
    const shopOrders = ordersByShop[shopId] || [];
    const uniqueBuyers = new Set(shopOrders.map((o) => o.buyerTelegramId));
    const shopSellerObjs = sellersByShop[shopId] || [];
    const assignedStaff = shopSellerObjs.filter((s) => s.role === 'seller' || s.role === 'admin');
    const orderedBuyers = orderedBuyersByShop[shopId] || new Set();
    const sellersWithStatus = shopSellerObjs.map((s) => ({ ...s, hasOrder: orderedBuyers.has(s.telegramId) }));
    // hasConflict: 2+ separate buyers placed orders in this shop this session
    // hasMultipleSellers: 2+ seller/admin users are assigned to this shop.
    // hasSellerOrderMismatch: multiple assigned users but only some placed orders.
    const hasMultipleSellers = assignedStaff.length > 1;
    const sellersWithOrder = assignedStaff.filter((s) => orderedBuyers.has(s.telegramId));
    const hasSellerOrderMismatch = hasMultipleSellers && shopOrders.length > 0 && sellersWithOrder.length !== assignedStaff.length;
    return {
      shopId,
      shopName: shop.name,
      shopCity: shop.cityId?.name || '',
      sellers: sellersWithStatus,
      sellerName: sellersWithStatus.length > 0 ? sellersWithStatus.map((s) => s.name).join(', ') : null,
      sellerCount: sellersWithStatus.length,
      cartItemCount,
      orderedItemCount: orderedByShop[shopId]?.size || 0,
      orders: shopOrders,
      hasConflict: uniqueBuyers.size > 1,
      hasMultipleSellers,
      hasSellerOrderMismatch,
    };
  });

  shopStatuses.sort((a, b) => String(a.shopCity || '').localeCompare(String(b.shopCity || ''), 'uk') || String(a.shopName || '').localeCompare(String(b.shopName || ''), 'uk'));

  res.json({
    groupId: String(group._id),
    groupName: group.name,
    isOpen: status.isOpen,
    currentSessionId,
    viewerRole: req.telegramUser?.role || '',
    staleOrderCount: staleOrders.length,
    staleOrders: staleOrders.map((order) => ({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: String(order.buyerTelegramId || ''),
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      shopName: order.buyerSnapshot?.shopName || '—',
      shopCity: order.buyerSnapshot?.shopCity || '',
      itemCount: (order.items || []).filter((i) => !i.cancelled).length,
      orderingSessionId: order.orderingSessionId || '',
      createdAt: order.createdAt,
    })),
    shops: shopStatuses,
  });
}));

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

router.post('/:id/close-ordering-session', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id).lean();
  if (!group) throw appError('group_not_found');

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
}));

router.get('/', async (req, res) => {
  const groups = await DeliveryGroup.find().lean();
  const normalizedGroups = groups.map(normalizeDeliveryGroup);
  normalizedGroups.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const schedule = await getOrderingSchedule();

  // Flag groups whose ordering session is currently CLOSED but still have active orders.
  // This covers any case — seller switched shop, admin moved order, whatever.
  // Orders in an OPEN session are resolved (normal or conflict), no badge needed.
  const closedGroupIds = [];
  for (const g of normalizedGroups) {
    const { isOpen } = isOrderingOpen(g.dayOfWeek, schedule);
    if (!isOpen) {
      closedGroupIds.push(String(g._id));
    }
  }
  const problematicByGroup = {};
  if (closedGroupIds.length > 0) {
    const ordersInClosedGroups = await Order.find({
      'buyerSnapshot.deliveryGroupId': { $in: closedGroupIds },
      status: { $in: ['new', 'in_progress'] },
    }).select('buyerSnapshot.deliveryGroupId').lean();
    for (const order of ordersInClosedGroups) {
      const groupId = order?.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '';
      if (groupId) problematicByGroup[groupId] = true;
    }
  }

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

  const result = normalizedGroups.map((g) => ({
    ...g,
    isOpen: isOrderingOpen(g.dayOfWeek, schedule).isOpen,
    shopCount: shopCountMap[String(g._id)] || 0,
    sellerCount: sellerCountMap[String(g._id)] || 0,
    hasRelocatedOrders: !!problematicByGroup[String(g._id)],
  }));
  res.json(result);
});

router.post('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { name, dayOfWeek } = req.body;
  if (!name || dayOfWeek === undefined) throw appError('group_name_or_day_required');

  const group = new DeliveryGroup({ name, dayOfWeek });
  await group.save();
  res.status(201).json(group);
}));

router.patch('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) throw appError('group_not_found');

  const { name, dayOfWeek } = req.body;
  if (name !== undefined) group.name = name;
  if (dayOfWeek !== undefined) group.dayOfWeek = dayOfWeek;

  await group.save();
  res.json(group);
}));

router.delete('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Check + delete in a single transaction so that a magazin or active order
  // created between the count and findByIdAndDelete cannot leave an orphan
  // reference behind.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const group = await DeliveryGroup.findById(req.params.id).session(session);
      if (!group) throw appError('group_not_found');

      const shopCount = await Shop.countDocuments({
        deliveryGroupId: String(group._id),
      }).session(session);
      if (shopCount > 0) throw appError('group_has_shops', { shopCount });

      const activeOrders = await Order.countDocuments({
        'buyerSnapshot.deliveryGroupId': String(group._id),
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (activeOrders > 0) throw appError('group_has_active_orders', { activeOrders });

      await DeliveryGroup.deleteOne({ _id: group._id }, { session });
      result = { message: 'Group deleted' };
    });
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

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
