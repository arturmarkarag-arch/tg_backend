const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const City = require('../models/City');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function syncUserWarehouseZone(user) {
  if (user.role === 'seller') {
    let zone = '';
    // New architecture: derive zone from shop -> deliveryGroup
    if (user.shopId) {
      const shop = await Shop.findById(user.shopId).lean();
      if (shop?.deliveryGroupId) {
        const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
        zone = group?.name || '';
      }
    } else if (user.deliveryGroupId) {
      // Legacy fallback
      const group = await DeliveryGroup.findById(user.deliveryGroupId).lean();
      zone = group?.name || '';
    }
    return await User.findByIdAndUpdate(user._id, { warehouseZone: zone }, { new: true });
  }
  if (user.role !== 'warehouse') {
    return await User.findByIdAndUpdate(user._id, { warehouseZone: '' }, { new: true });
  }
  return user;
}

async function sanitizeUserPayload(payload, existing = null) {
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
    data.shopId = payload.shopId || null;
    data.shopNumber = payload.shopNumber;
    data.shopName = payload.shopName;
    data.shopAddress = payload.shopAddress;
    data.shopCity = payload.shopCity;
    // deliveryGroupId is derived from the shop — never trust client-supplied value
    if (data.shopId) {
      const shop = await Shop.findById(data.shopId).lean();
      data.deliveryGroupId = shop?.deliveryGroupId || '';
    } else {
      data.deliveryGroupId = '';
    }
  } else {
    data.shopId = null;
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
  try {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 20));
  const roleFilter     = req.query.role || null;
  const groupFilter    = req.query.deliveryGroupId || null;
  const cityFilter     = req.query.shopCity || null;
  const activityFilter = req.query.activityFilter || null; // 'no_cart' | 'no_order' | 'no_visit'

  const filter = {};
  if (roleFilter && roleFilter !== 'all') filter.role = roleFilter;
  if (groupFilter && groupFilter !== 'all') filter.deliveryGroupId = groupFilter;
  if (cityFilter && cityFilter !== 'all') {
    const city = await City.findOne({ name: cityFilter }).lean();
    if (city) {
      const shopsInCity = await Shop.find({ cityId: city._id }, '_id').lean();
      filter.shopId = { $in: shopsInCity.map((s) => s._id) };
    } else {
      // No city found — return empty
      filter.shopId = { $in: [] };
    }
  }

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
      windowOrderQty: 0, // by definition — these users have no window orders
    }));
  } else if (activityFilter && windowIsOpen && windowOpenAt) {
    // no_cart / no_visit: push filter to MongoDB query — no in-memory scan
    if (activityFilter === 'no_cart') {
      // Cart is now on Shop — find shops with non-empty cart and exclude their sellers
      const shopsWithCart = await Shop.find(
        { 'cartState.orderItemIds.0': { $exists: true } },
        '_id'
      ).lean();
      const shopIdsWithCart = shopsWithCart.map((s) => s._id);
      filter['$or'] = [
        { shopId: { $exists: false } },
        { shopId: null },
        { shopId: { $nin: shopIdsWithCart } },
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
    // Enrich with order data for display
    const activityTids = users.map((u) => u.telegramId).filter(Boolean);
    const activityOrders = await Order.aggregate([
      { $match: { buyerTelegramId: { $in: activityTids }, createdAt: { $gte: windowOpenAt }, status: { $nin: ['cancelled', 'expired'] } } },
      { $unwind: '$items' },
      { $group: { _id: '$buyerTelegramId', totalQty: { $sum: '$items.quantity' } } },
    ]);
    const activityOrderQtyMap = new Map(activityOrders.map((o) => [o._id, o.totalQty]));
    users = users.map((u) => ({
      ...u,
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
        windowOrderQty: orderQtyMap.get(u.telegramId) || 0,
      }));
    }
  }

  // Batch-load shop cartState to compute cartItemCount
  const shopIds = [...new Set(users.map((u) => u.shopId).filter(Boolean).map(String))];
  const shopDocs = shopIds.length > 0 ? await Shop.find({ _id: { $in: shopIds } }, 'cartState').lean() : [];
  const shopMap = new Map(shopDocs.map((s) => [String(s._id), s]));
  const getCartCount = (u) => {
    if (!u.shopId) return 0;
    const shop = shopMap.get(String(u.shopId));
    const items = shop?.cartState?.orderItems;
    if (!items) return 0;
    const obj = items instanceof Map ? Object.fromEntries(items) : items;
    return Object.values(obj).reduce((s, q) => s + (Number(q) || 0), 0);
  };

  const telegramIds = users.map((u) => u.telegramId).filter(Boolean);
  const lastOrders = await Order.aggregate([
    { $match: { buyerTelegramId: { $in: telegramIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$buyerTelegramId', lastOrderAt: { $first: '$createdAt' } } },
  ]);
  const lastOrderMap = new Map(lastOrders.map((item) => [item._id, item.lastOrderAt]));
  const usersWithLastOrder = users.map((user) => ({
    ...user,
    cartItemCount: getCartCount(user),
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
  } catch (err) {
    console.error('[GET /users]', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/:telegramId', async (req, res) => {
  const user = await User.findOne({ telegramId: req.params.telegramId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/', async (req, res) => {
  const existing = await User.findOne({ telegramId: req.body.telegramId });
  const payload = await sanitizeUserPayload(req.body, existing);
  // telegramId береться з body тільки при створенні нового юзера
  if (!existing) payload.telegramId = req.body.telegramId;
  let user;
  if (existing) {
    user = await User.findByIdAndUpdate(existing._id, payload, { new: true, runValidators: true });
  } else {
    user = new User(payload);
    await user.save();
  }

  user = await syncUserWarehouseZone(user);
  res.status(existing ? 200 : 201).json(user);
});

// Lightweight endpoint — only updates shopId + syncs deliveryGroupId from the shop
router.patch('/:telegramId/shop', async (req, res) => {
  try {
    const existing = await User.findOne({ telegramId: req.params.telegramId });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const { shopId } = req.body;
    const oldShopId = existing.shopId ? String(existing.shopId) : '';
    const newShopId = shopId ? String(shopId) : '';
    let deliveryGroupId = existing.deliveryGroupId || null;

    if (shopId) {
      const shop = await Shop.findById(shopId).lean();
      if (!shop) return res.status(404).json({ error: 'Shop not found' });
      deliveryGroupId = shop.deliveryGroupId || null;
    } else {
      deliveryGroupId = null;
    }

    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      { shopId: shopId || null, deliveryGroupId },
      { new: true }
    );

    if (oldShopId !== newShopId) {
      const [oldShop, newShop, activeOrders] = await Promise.all([
        oldShopId ? Shop.findById(oldShopId, 'name').lean() : Promise.resolve(null),
        newShopId ? Shop.findById(newShopId, 'name').lean() : Promise.resolve(null),
        Order.countDocuments({ buyerTelegramId: existing.telegramId, status: { $in: ['new', 'in_progress'] } }),
      ]);
      const actor = req.telegramUser;
      await User.updateOne(
        { telegramId: req.params.telegramId },
        { $push: { history: {
          at: new Date(),
          by: String(actor.telegramId),
          byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
          byRole: actor.role,
          action: 'shop_changed',
          meta: { fromShop: oldShop?.name || null, toShop: newShop?.name || null, activeOrders },
        } } }
      );
      // Persist last-seller snapshot on the old shop so the hint survives user deletion
      if (oldShopId) {
        await Shop.findByIdAndUpdate(oldShopId, {
          lastSeller: {
            telegramId: existing.telegramId,
            firstName:  existing.firstName  || '',
            lastName:   existing.lastName   || '',
            unassignedAt: new Date(),
          },
        }).catch(() => {});
      }
    }

    res.json(user);
  } catch (err) {
    console.error('[PATCH /users/:telegramId/shop]', err);
    res.status(500).json({ error: 'Failed to update shop assignment' });
  }
});

router.patch('/:telegramId', async (req, res) => {
  try {
    const existing = await User.findOne({ telegramId: req.params.telegramId });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const payload = await sanitizeUserPayload(req.body, existing);
    const user = await User.findOneAndUpdate(
      { telegramId: req.params.telegramId },
      payload,
      { new: true, runValidators: true }
    );
    const updatedUser = await syncUserWarehouseZone(user);

    // Log shop and role changes
    const historyEntries = [];
    const actor = req.telegramUser;
    const actorMeta = {
      by: String(actor.telegramId),
      byName: [actor.firstName, actor.lastName].filter(Boolean).join(' '),
      byRole: actor.role,
    };

    if (String(existing.shopId || '') !== String(payload.shopId || '')) {
      const [oldShop, newShop, activeOrders] = await Promise.all([
        existing.shopId ? Shop.findById(existing.shopId, 'name').lean() : Promise.resolve(null),
        payload.shopId ? Shop.findById(payload.shopId, 'name').lean() : Promise.resolve(null),
        Order.countDocuments({ buyerTelegramId: existing.telegramId, status: { $in: ['new', 'in_progress'] } }),
      ]);
      historyEntries.push({ at: new Date(), ...actorMeta, action: 'shop_changed', meta: { fromShop: oldShop?.name || null, toShop: newShop?.name || null, activeOrders } });
    }

    if (existing.role !== payload.role) {
      historyEntries.push({ at: new Date(), ...actorMeta, action: 'role_changed', meta: { from: existing.role, to: payload.role } });
    }

    if (historyEntries.length > 0) {
      await User.updateOne(
        { telegramId: req.params.telegramId },
        { $push: { history: { $each: historyEntries } } }
      );
    }

    res.json(updatedUser);
  } catch (err) {
    console.error('[PATCH /users/:telegramId]', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/:telegramId', async (req, res) => {
  const user = await User.findOneAndDelete({ telegramId: req.params.telegramId });
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Preserve seller identity on the shop so "Раніше тут був" hint survives deletion
  if (user.shopId) {
    await Shop.findByIdAndUpdate(user.shopId, {
      lastSeller: {
        telegramId:   user.telegramId,
        firstName:    user.firstName  || '',
        lastName:     user.lastName   || '',
        unassignedAt: new Date(),
      },
    }).catch(() => {});
  }
  res.json({ message: 'User deleted' });
});

module.exports = router;
