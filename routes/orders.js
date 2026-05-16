const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const Receipt = require('../models/Receipt');
const User = require('../models/User');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const { getTelegramAuth } = require('../utils/validateTelegramInitData');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');
const { getIO } = require('../socket');
const { isOrderingOpen, getOrderingWindowOpenAt, getCurrentOrderingSessionId } = require('../utils/orderingSchedule');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError, asyncHandler } = require('../utils/errors');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const cache = require('../utils/cache');
const { getShop, getDeliveryGroup } = require('../utils/modelCache');
const { withLock } = require('../utils/lock');

async function getAllDeliveryGroups() {
  let groups = await cache.get(cache.KEYS.DELIVERY_GROUPS);
  if (!groups) {
    groups = await DeliveryGroup.find().lean();
    await cache.set(cache.KEYS.DELIVERY_GROUPS, groups);
  }
  return groups;
}

const router = express.Router();
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly = requireTelegramRoles(['admin']);

async function getNextOrderNumber() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'orderNumber' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return counter.seq;
}

function actorFromReq(req) {
  const u = req.telegramUser;
  if (!u) return { by: 'system', byName: '', byRole: 'system' };
  return {
    by: String(u.telegramId),
    byName: [u.firstName, u.lastName].filter(Boolean).join(' '),
    byRole: u.role,
  };
}

async function ensureOrderIsStale(order, session = null) {
  const groupId = order?.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '';
  if (!groupId) return;

  const groupQuery = DeliveryGroup.findById(groupId).lean();
  const group = session ? await groupQuery.session(session) : await groupQuery;
  if (!group) return;

  const normalizedGroup = normalizeDeliveryGroup(group);
  const schedule = await getOrderingSchedule();
  const currentSessionId = getCurrentOrderingSessionId(String(normalizedGroup._id), normalizedGroup.dayOfWeek, schedule);
  if (String(order.orderingSessionId || '') === String(currentSessionId || '')) {
    throw appError('validation_failed', { field: 'orderingSessionId', details: 'order_is_current_session' });
  }
}

async function detachOrderFromPendingTasks(orderId, session) {
  await PickingTask.updateMany(
    { 'items.orderId': orderId, status: { $in: ['pending', 'locked'] } },
    { $pull: { items: { orderId } } },
    { session },
  );

  await PickingTask.deleteMany(
    { status: { $in: ['pending', 'locked'] }, items: { $size: 0 } },
    { session },
  );
}

async function ensureOrderNotInPickingPipeline(orderId, session = null) {
  const query = PickingTask.exists({
    'items.orderId': orderId,
    status: { $in: ['pending', 'locked', 'completed'] },
  });
  const exists = session ? await query.session(session) : await query;
  if (exists) {
    throw appError('order_picking_started');
  }
}

async function ensureOrderNotLockedByWarehouse(orderId, session = null) {
  const query = PickingTask.exists({
    'items.orderId': orderId,
    status: 'locked',
  });
  const exists = session ? await query.session(session) : await query;
  if (exists) {
    throw appError('order_picking_locked');
  }
}

/**
 * Middleware: returns 423 Locked when the ordering window is closed for a seller.
 * Staff (admin / warehouse) always pass through unchanged.
 * Requires telegramAuth to have run first (req.telegramUser populated).
 */
async function requireOrderingWindowOpen(req, res, next) {
  try {
    const user = req.telegramUser;
    if (!user || user.role !== 'seller') return next();

    if (!user.shopId) {
      return res.status(403).json({
        error: 'no_shop',
        message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      });
    }

    const shop = await Shop.findById(user.shopId).lean();
    if (!shop || !shop.deliveryGroupId) {
      return res.status(403).json({
        error: 'no_delivery_group',
        message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      });
    }

    const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
    if (!group) {
      return res.status(403).json({
        error: 'delivery_group_not_found',
        message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      });
    }

    const schedule = await getOrderingSchedule();
    const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
    if (!isOpen) {
      return res.status(423).json({ error: 'ordering_closed', message });
    }

    next();
  } catch (err) {
    next(err);
  }
}

// POST / has custom registration-check logic so handles its own auth
router.use((req, res, next) => {
  if (req.method === 'POST') return next();
  return telegramAuth(req, res, next);
});

function isProductAvailable(product) {
  return Boolean(product) && product.status !== 'archived';
}

function buildProductLabel(product) {
  return product.brand || product.model || product.category || product.warehouse || `#${product.orderNumber}`;
}

/**
 * GET /conflicts — returns shops with 2+ orders from different sellers in active sessions.
 * Admin and warehouse only.
 */
router.get('/conflicts', staffOnly, async (req, res) => {
  // Collect all active delivery groups with their current sessionId so we can filter
  // only orders that belong to the CURRENT ordering session — stale unresolved orders
  // from previous sessions should not pollute today's picking dashboard.
  const allGroups = (await getAllDeliveryGroups()).map(normalizeDeliveryGroup);
  const schedule = await getOrderingSchedule();

  const currentSessionIds = new Set();
  for (const group of allGroups) {
    const sid = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
    if (sid) currentSessionIds.add(sid);
  }

  const sessionFilter = currentSessionIds.size > 0
    ? { orderingSessionId: { $in: [...currentSessionIds] } }
    : {};

  const activeOrders = await Order.find({
    status: { $in: ['new', 'in_progress'] },
    ...sessionFilter,
  }).select('shopId buyerSnapshot buyerTelegramId orderNumber _id createdAt items').lean();

  // Group by shopId
  const byShop = new Map();
  for (const order of activeOrders) {
    const shopId = String(order.shopId || order.buyerSnapshot?.shopId || '');
    if (!shopId) continue;
    if (!byShop.has(shopId)) byShop.set(shopId, []);
    byShop.get(shopId).push(order);
  }

  // Find shops with orders from more than one unique buyer
  const conflictShopIds = [...byShop.entries()]
    .filter(([, orders]) => new Set(orders.map((o) => o.buyerTelegramId)).size > 1)
    .map(([shopId]) => shopId);

  if (conflictShopIds.length === 0) return res.json({ conflicts: [] });

  // Look up shop names
  const shops = await require('../models/Shop').find({ _id: { $in: conflictShopIds } })
    .populate('cityId', 'name')
    .select('name cityId')
    .lean();
  const shopInfoById = {};
  for (const s of shops) {
    shopInfoById[String(s._id)] = { shopName: s.name || '', shopCity: s.cityId?.name || '' };
  }

  // Look up buyer names
  const buyerTgIds = [...new Set(activeOrders.map((o) => o.buyerTelegramId).filter(Boolean))];
  const buyers = await User.find({ telegramId: { $in: buyerTgIds } })
    .select('telegramId firstName lastName')
    .lean();
  const buyerNameById = {};
  for (const b of buyers) {
    buyerNameById[String(b.telegramId)] = [b.firstName, b.lastName].filter(Boolean).join(' ') || b.telegramId;
  }

  const conflicts = conflictShopIds.map((shopId) => {
    const orders = (byShop.get(shopId) || []).map((o) => ({
      orderId: String(o._id),
      orderNumber: o.orderNumber,
      buyerTelegramId: o.buyerTelegramId,
      buyerName: buyerNameById[String(o.buyerTelegramId)] || o.buyerTelegramId,
      itemCount: (o.items || []).filter((i) => !i.cancelled).length,
      createdAt: o.createdAt,
    }));
    return {
      shopId,
      ...shopInfoById[shopId],
      orders,
    };
  });

  res.json({ conflicts });
});

/**
 * GET /history — returns order history, optionally grouped/filtered by shop or session.
 * Admin and warehouse only.
 */
router.get('/history', staffOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.max(1, parseInt(req.query.pageSize) || 50);
  const shopId = req.query.shopId;
  const sessionId = req.query.sessionId;
  const from = req.query.from;
  const to = req.query.to;

  const filter = {
    status: { $ne: 'cancelled' },
  };

  if (shopId) {
    filter.$or = [
      { 'shopId': mongoose.Types.ObjectId.isValid(shopId) ? shopId : null },
      { 'buyerSnapshot.shopId': shopId },
    ];
  }

  if (sessionId) {
    filter.orderingSessionId = sessionId;
  }

  if (from || to) {
    const dateQuery = {};
    if (from) {
      const parsedFrom = new Date(from);
      if (!Number.isNaN(parsedFrom.getTime())) {
        dateQuery.$gte = parsedFrom;
      }
    }
    if (to) {
      const parsedTo = new Date(to);
      if (!Number.isNaN(parsedTo.getTime())) {
        dateQuery.$lt = parsedTo;
      }
    }
    if (Object.keys(dateQuery).length) {
      filter.createdAt = dateQuery;
    }
  }

  const total = await Order.countDocuments(filter);
  const orders = await Order.find(filter)
    .populate('items.productId')
    .populate('shopId', 'name address cityId')
    .sort({ createdAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .lean();

  const buyerIds = [...new Set(orders.map((o) => o.buyerTelegramId))];
  const buyers = await User.find({ telegramId: { $in: buyerIds } }).lean();
  const buyerMap = new Map(buyers.map((b) => [b.telegramId, b]));

  // Group by session
  const bySession = new Map();
  for (const order of orders) {
    const sid = order.orderingSessionId || 'unknown';
    if (!bySession.has(sid)) {
      bySession.set(sid, []);
    }
    bySession.get(sid).push(order);
  }

  const sessions = Array.from(bySession.entries()).map(([sessionId, sessionOrders]) => ({
    sessionId,
    orderCount: sessionOrders.length,
    totalRevenue: sessionOrders.reduce((sum, o) => sum + o.totalPrice, 0),
    shops: Array.from(
      sessionOrders.reduce((acc, order) => {
        const shopId = String(order.shopId?._id || order.buyerSnapshot?.shopId || 'unknown');
        if (!acc.has(shopId)) {
          acc.set(shopId, {
            shopId,
            shopName: order.shopId?.name || order.buyerSnapshot?.shopName || 'Unknown',
            shopAddress: order.shopId?.address || order.buyerSnapshot?.shopAddress || '',
            shopCity: order.shopId?.cityId?.name || order.buyerSnapshot?.shopCity || '',
            orders: [],
          });
        }
        acc.get(shopId).orders.push(order);
        return acc;
      }, new Map()).values()
    ).map((shop) => ({
      ...shop,
      orders: shop.orders.map((order) => {
        const buyer = buyerMap.get(order.buyerTelegramId);
        return {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          buyerTelegramId: order.buyerTelegramId,
          buyerName: [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || order.buyerTelegramId,
          status: order.status,
          totalPrice: order.totalPrice,
          itemCount: (order.items || []).filter((i) => !i.cancelled).length,
          createdAt: order.createdAt,
        };
      }),
    })),
  }));

  res.json({
    sessions,
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  });
}));

/**
 * GET /session/current — returns current session orders grouped by shop.
 * Admin and warehouse only. Groups orders by shop and returns them with buyer/product details.
 */
router.get('/session/current', staffOnly, asyncHandler(async (req, res) => {
  const { shopId: filterShopId } = req.query;

  // Get all delivery groups and current session IDs
  const allGroups = (await getAllDeliveryGroups()).map(normalizeDeliveryGroup);
  const schedule = await getOrderingSchedule();

  const currentSessionIds = new Set();
  for (const group of allGroups) {
    const sid = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
    if (sid) currentSessionIds.add(sid);
  }

  const sessionFilter = currentSessionIds.size > 0
    ? { orderingSessionId: { $in: [...currentSessionIds] } }
    : {};

  // Get all orders from current session (excluding cancelled)
  const orders = await Order.find({
    status: { $ne: 'cancelled' },
    ...sessionFilter,
  })
    .populate('items.productId')
    .populate('shopId', 'name address cityId')
    .lean();

  // Filter by shop if requested
  let filteredOrders = orders;
  if (filterShopId) {
    filteredOrders = orders.filter((o) => String(o.shopId?._id || o.buyerSnapshot?.shopId || '') === String(filterShopId));
  }

  // Get unique buyer IDs
  const buyerIds = [...new Set(filteredOrders.map((o) => o.buyerTelegramId))];
  const buyers = await User.find({ telegramId: { $in: buyerIds } }).lean();
  const buyerMap = new Map(buyers.map((b) => [b.telegramId, b]));

  // Group orders by shop
  const byShop = new Map();
  for (const order of filteredOrders) {
    const shopId = String(order.shopId?._id || order.buyerSnapshot?.shopId || 'unknown');
    if (!byShop.has(shopId)) {
      byShop.set(shopId, {
        shopId,
        shopName: order.shopId?.name || order.buyerSnapshot?.shopName || 'Unknown',
        shopAddress: order.shopId?.address || order.buyerSnapshot?.shopAddress || '',
        shopCity: order.shopId?.cityId?.name || order.buyerSnapshot?.shopCity || '',
        orders: [],
      });
    }
    byShop.get(shopId).orders.push(order);
  }

  // Format response
  const shops = Array.from(byShop.values()).map((shopGroup) => ({
    ...shopGroup,
    orders: shopGroup.orders.map((order) => {
      const buyer = buyerMap.get(order.buyerTelegramId);
      const items = (order.items || [])
        .filter((item) => !item.cancelled)
        .map((item) => ({
          productId: String(item.productId?._id || item.productId || ''),
          productName: item.name || item.productId?.model || 'Unknown',
          quantity: item.quantity,
          price: item.price,
          packed: item.packed,
        }));

      return {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        buyerTelegramId: order.buyerTelegramId,
        buyerName: [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || order.buyerTelegramId,
        status: order.status,
        totalPrice: order.totalPrice,
        createdAt: order.createdAt,
        items,
      };
    }),
  }));

  res.json({
    shops,
    sessionIds: Array.from(currentSessionIds),
  });
}));

router.get('/', async (req, res) => {
  const telegramId = req.telegramId;
  const authUser = req.telegramUser;

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = req.query.pageSize !== undefined
    ? Math.max(0, Number(req.query.pageSize))
    : 20;
  const status = req.query.status; // optional: 'new', 'confirmed', 'fulfilled', 'cancelled'
  const buyerTelegramId = req.query.buyerTelegramId;
  const from = req.query.from;
  const to = req.query.to;

  const filter = {};
  if (buyerTelegramId) {
    if (String(buyerTelegramId) !== telegramId && !['admin', 'warehouse'].includes(authUser.role)) {
      throw appError('order_query_forbidden');
    }
    filter.buyerTelegramId = String(buyerTelegramId);
  } else if (!['admin', 'warehouse'].includes(authUser.role)) {
    filter.buyerTelegramId = telegramId;
  }

  if (status && status !== 'all') {
    filter.status = status;
  } else if (!status) {
    // By default exclude cancelled
    filter.status = { $ne: 'cancelled' };
  }

  if (from || to) {
    const dateQuery = {};
    if (from) {
      const parsedFrom = new Date(from);
      if (!Number.isNaN(parsedFrom.getTime())) {
        dateQuery.$gte = parsedFrom;
      }
    }
    if (to) {
      const parsedTo = new Date(to);
      if (!Number.isNaN(parsedTo.getTime())) {
        dateQuery.$lt = parsedTo;
      }
    }
    if (Object.keys(dateQuery).length) {
      filter.createdAt = dateQuery;
    }
  }

  const total = await Order.countDocuments(filter);
  const orderQuery = Order.find(filter)
    .populate('items.productId')
    .populate('receiptId', 'receiptNumber')
    .sort({ createdAt: -1 });

  if (pageSize > 0) {
    orderQuery.skip((page - 1) * pageSize).limit(pageSize);
  }

  const orders = await orderQuery;

  const buyerIds = [...new Set(orders.map((o) => o.buyerTelegramId))];
  const buyers = await User.find({ telegramId: { $in: buyerIds } });
  const buyerMap = new Map(buyers.map((buyer) => [buyer.telegramId, buyer]));

  const items = orders.map((order) => {
    const obj = order.toObject();
    obj.receiptNumber = order.receiptId?.receiptNumber || '';
    const buyer = buyerMap.get(order.buyerTelegramId);
    const snap = order.buyerSnapshot;
    obj.buyer = {
      telegramId: order.buyerTelegramId,
      shopName: snap?.shopName ?? '',
      shopAddress: snap?.shopAddress ?? '',
      shopCity: snap?.shopCity ?? '',
      firstName: buyer?.firstName ?? '',
      lastName: buyer?.lastName ?? '',
      phoneNumber: buyer?.phoneNumber ?? '',
    };
    return obj;
  });

  res.json({
    orders: items,
    total,
    page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 1,
  });
});

router.get('/transit/active', staffOnly, async (req, res) => {
  try {
    const orders = await Order.find({
      orderType: 'direct_allocation',
      status: { $nin: ['fulfilled', 'cancelled'] },
    })
      .populate('items.productId')
      .populate('receiptId', 'receiptNumber')
      .sort({ createdAt: -1 })
      .lean();

    const buyerIds = [...new Set(orders.map((o) => o.buyerTelegramId))];
    const buyers = await User.find({ telegramId: { $in: buyerIds } }).lean();
    const buyerMap = buyers.reduce((acc, buyer) => ({ ...acc, [buyer.telegramId]: buyer }), {});

    const enrichedOrders = orders.map((o) => {
      const buyer = buyerMap[o.buyerTelegramId] || {};
      const snap = o.buyerSnapshot;
      return {
        ...o,
        buyerDetails: {
          telegramId: o.buyerTelegramId,
          shopName: snap?.shopName ?? '',
          shopAddress: snap?.shopAddress ?? '',
          shopCity: snap?.shopCity ?? '',
          firstName: buyer.firstName ?? '',
          lastName: buyer.lastName ?? '',
          phoneNumber: buyer.phoneNumber ?? '',
        },
        receiptNumber: o.receiptId?.receiptNumber || '',
      };
    });

    res.json(enrichedOrders);
  } catch (error) {
    console.error('[orders.transit.active] Error:', error);
    next(appError('order_transit_failed'));
  }
});

router.post('/:id/fulfill', telegramAuth, staffOnly, async (req, res, next) => {
  try {
    return next(appError('order_status_change_disabled'));
  } catch (error) {
    console.error('[orders.fulfill] Error:', error);
    next(appError('order_fulfill_failed'));
  }
});

router.get('/:id', async (req, res) => {
  const telegramId = req.telegramId;
  const authUser = req.telegramUser;

  const order = await Order.findById(req.params.id).populate('items.productId');
  if (!order) throw appError('order_not_found');
  if (String(order.buyerTelegramId) !== telegramId && !['admin', 'warehouse'].includes(authUser.role)) {
    throw appError('order_view_forbidden');
  }

  const buyer = await User.findOne({ telegramId: order.buyerTelegramId });
  const obj = order.toObject();
  const snap = obj.buyerSnapshot;
  obj.buyer = {
    telegramId: order.buyerTelegramId,
    shopName: snap?.shopName ?? '',
    shopAddress: snap?.shopAddress ?? '',
    shopCity: snap?.shopCity ?? '',
    firstName: buyer?.firstName ?? '',
    lastName: buyer?.lastName ?? '',
    phoneNumber: buyer?.phoneNumber ?? '',
  };
  res.json(obj);
});

router.post('/', asyncHandler(async (req, res) => {
  const { idempotencyKey } = req.body;
  const sanitizedKeyEarly = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;

  // Idempotency: serialise duplicate POSTs on the same key so the second waits
  // for the first commit and returns the existing order, without burning an
  // orderNumber. If no key is supplied, fall back to the old behaviour.
  if (sanitizedKeyEarly) {
    return withLock(`order:idem:${sanitizedKeyEarly}`, async () => {
      const existing = await Order.findOne({ idempotencyKey: sanitizedKeyEarly }).lean();
      if (existing) {
        return res.status(200).json(existing);
      }
      return placeOrderImpl(req, res);
    }, { ttlMs: 30_000, waitMs: 20_000 });
  }
  return placeOrderImpl(req, res);
}));

async function placeOrderImpl(req, res) {
  const { initData, buyerTelegramId, items, shippingAddress, contactInfo, emojiType, idempotencyKey } = req.body;

  const validation = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!validation.valid) {
    throw appError('order_invalid_initdata');
  }

  const telegramId = String(validation.telegramId || '');
  if (!telegramId) {
    throw appError('order_invalid_initdata');
  }

  if (buyerTelegramId && String(buyerTelegramId) !== telegramId) {
    throw appError('order_buyer_mismatch');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw appError('order_items_required');
  }

  const buyer = await User.findOne({ telegramId }).lean();
  if (!buyer) {
    return res.status(403).json({ error: 'not_registered', message: 'Потрібно завершити реєстрацію, перш ніж робити замовлення' });
  }

  const sanitizedKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;

  // Every user must have a shopId to place an order — no shopId means nowhere to deliver.
  // shop, group and schedule are kept in outer scope so the merge logic can use them below
  let shop = null;
  let group = null;
  let schedule = null;
  if (!buyer.shopId) {
    return res.status(403).json({
      error: 'no_shop',
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
    });
  }
  if (buyer.role === 'seller' || buyer.role === 'admin' || buyer.role === 'warehouse') {
    shop = await getShop(buyer.shopId);
    if (!shop || !shop.deliveryGroupId) {
      return res.status(403).json({
        error: 'no_delivery_group',
        message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      });
    }
    group = await getDeliveryGroup(shop.deliveryGroupId);
    if (!group) {
      return res.status(403).json({
        error: 'delivery_group_not_found',
        message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      });
    }
    schedule = await getOrderingSchedule();
    // Seller and admin are bound by the ordering window.
    // Warehouse workers are NOT allowed to place orders at all.
    if (buyer.role === 'warehouse') {
      return res.status(403).json({
        error: 'order_role_forbidden',
        message: 'Працівники складу не можуть робити замовлення.',
      });
    }
    const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
    if (!isOpen) {
      return res.status(423).json({ error: 'ordering_closed', message });
    }
  }

  const productIds = items
    .map((item) => item?.productId)
    .filter(Boolean)
    .map(String);

  const realProducts = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(realProducts.map((product) => [String(product._id), product]));

  let totalPrice = 0;
  const validItems = [];
  const archivedItems = []; // items that exist but are already archived

  for (const item of items) {
    const productId = String(item?.productId || '');
    const product = productMap.get(productId);
    if (!product) continue;
    if (!isProductAvailable(product)) {
      archivedItems.push({
        productId,
        name: buildProductLabel(product),
      });
      continue;
    }

    const quantity = Math.min(1000, Math.max(1, parseInt(item.quantity, 10) || 1));
    if (quantity <= 0) continue;

    const price = Number(product.price || 0);

    validItems.push({
      productId: product._id,
      name: product.brand || product.model || product.category || `#${product.orderNumber}`,
      price,
      quantity,
      packed: false,
      cancelled: false,
    });

    totalPrice += price * quantity;
  }

  if (validItems.length === 0) {
    throw appError('order_no_valid_items');
  }

  // Guard: all buyers cannot order products that are not placed in any block.
  // Such products have no physical location on the warehouse floor and will
  // never generate a PickingTask in buildPickingTasksFromOrders.
  {
    const validProductIds = validItems.map((i) => i.productId);
    const inBlockIds = await Block.distinct('productIds', { productIds: { $in: validProductIds } });
    const inBlockSet = new Set(inBlockIds.map(String));
    const notInBlock = validItems.filter((i) => !inBlockSet.has(String(i.productId)));
    if (notInBlock.length > 0) {
      return res.status(422).json({
        error: 'product_not_in_block',
        message: `Товар "${notInBlock[0].name}" ще не розміщений у жодному блоці на складі. Замовлення неможливе.`,
        productIds: notInBlock.map((i) => String(i.productId)),
      });
    }
  }

  // Build existingOrder query: sellers merge per SHOP within the current ordering session.
  // admin/warehouse fall back to a 3-day per-buyer window.
  const existingOrderQuery = {
    status: { $in: ['new', 'in_progress'] },
  };
  let currentSessionId = '';
  if (group && schedule) {
    // All roles with a delivery group: merge within the active ordering session.
    // This includes warehouse, which now also gets orderingSessionId for conflict detection.
    currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery['buyerSnapshot.shopId'] = buyer.shopId;
    existingOrderQuery.orderingSessionId = currentSessionId;
  } else {
    // Fallback (e.g. buyer has no delivery group) — use 3-day window per buyer
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery.createdAt = { $gte: threeDaysAgo };
  }

  // Build buyerSnapshot — reflects the shop at the moment of the order
  const buyerSnapshot = group ? {
    shopId: buyer.shopId || null,
    shopName: shop?.name || '',
    shopCity: shop?.cityId?.name || '',
    shopAddress: shop?.address || '',
    deliveryGroupId: String(group._id),
  } : {
    shopId: buyer.shopId || null,
    shopName: shop?.name || '',
    shopCity: shop?.cityId?.name || '',
    shopAddress: shop?.address || '',
    deliveryGroupId: buyer.deliveryGroupId || '',
  };

  const buyerActor = {
    by: String(buyer.telegramId),
    byName: [buyer.firstName, buyer.lastName].filter(Boolean).join(' '),
    byRole: buyer.role,
  };

  // Wrap the read-modify-write in a MongoDB transaction so that concurrent requests cannot
  // interleave their reads and saves, which would cause later saves to overwrite merged items.
  let order;
  const mongoSession = await mongoose.connection.startSession();
  mongoSession.startTransaction();
  try {
    const txExisting = await Order.findOne(existingOrderQuery).session(mongoSession);

    if (txExisting) {
      for (const newItem of validItems) {
        const sameItem = txExisting.items.find((i) => String(i.productId) === String(newItem.productId));
        if (sameItem) {
          sameItem.quantity += newItem.quantity;
          sameItem.packed = false;
          sameItem.cancelled = false;
        } else {
          txExisting.items.push(newItem);
        }
      }

      // Keep snapshot in sync with current shop data on every merge
      txExisting.buyerTelegramId = buyer.telegramId;
      txExisting.shopId = buyer.shopId || null;
      txExisting.buyerSnapshot = buyerSnapshot;
      if (currentSessionId) txExisting.orderingSessionId = currentSessionId;

      txExisting.totalPrice = txExisting.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0);
      if (txExisting.status === 'new' || txExisting.status === 'in_progress') {
        txExisting.status = 'in_progress';
      }
      txExisting.history.push({
        ...buyerActor,
        action: 'items_merged',
        meta: {
          addedItems: validItems.map((i) => ({ name: i.name, qty: i.quantity })),
          totalItems: txExisting.items.filter((i) => !i.cancelled).length,
        },
      });
      await txExisting.save({ session: mongoSession });
      order = txExisting;
    } else {
      order = new Order({
        buyerTelegramId: buyer.telegramId,
        shopId: buyer.shopId || null,
        items: validItems,
        shippingAddress,
        contactInfo,
        emojiType,
        totalPrice,
        orderingSessionId: currentSessionId,
        buyerSnapshot,
        orderNumber: await getNextOrderNumber(),
        ...(sanitizedKey ? { idempotencyKey: sanitizedKey } : {}),
        history: [{
          ...buyerActor,
          action: 'order_created',
          meta: {
            shopName: buyerSnapshot.shopName,
            shopCity: buyerSnapshot.shopCity,
            itemCount: validItems.length,
          },
        }],
      });
      await order.save({ session: mongoSession });
    }

    // Clear the buyer's cart inside the SAME transaction. Якщо винести цю
    // операцію назовні (як було раніше з .catch warn), отримаємо вікно, у якому
    // замовлення вже існує, але кошик ще «повний» — і клієнт може повторно
    // оформити те саме. Тепер або обидві дії проходять, або жодна.
    {
      const activePositions = (order.items || []).filter((i) => !i.cancelled).length;
      await User.updateOne(
        { telegramId: buyer.telegramId },
        {
          $set: {
            'cartState.lastOrderPositions': activePositions,
            'cartState.orderItems': {},
            'cartState.orderItemIds': [],
            'cartState.updatedAt': new Date(),
          },
        },
        { session: mongoSession },
      );
    }

    await mongoSession.commitTransaction();
  } catch (err) {
    await mongoSession.abortTransaction();
    // Idempotency key collision: another request already created this order
    if (err.code === 11000 && sanitizedKey) {
      mongoSession.endSession();
      const existing = await Order.findOne({ idempotencyKey: sanitizedKey }).lean();
      if (existing) return res.status(200).json(existing);
    }
    throw err;
  } finally {
    mongoSession.endSession();
  }

  // Save order position count and clear the user's cart (order is placed — cart is done)
  // NOTE: cart-clear is now performed INSIDE the transaction above (atomic with
  // order.save). Тут лише пост-дії: емітимо сокет і повертаємо клієнту явний
  // статус, чи вдалося оповістити підписників — щоб UI не «думав», що все ок,
  // коли real-time оновлення фактично не пройшло.
  let socketDelivered = true;
  let socketError = null;
  try {
    const io = getIO();
    if (io) {
      io.emit('user_order_updated', {
        buyerTelegramId: buyer.telegramId,
        lastOrderAt: order.createdAt,
      });
      // Notify picking-group watchers of new/updated order
      const groupId = order.buyerSnapshot?.deliveryGroupId;
      if (groupId) {
        io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId: String(groupId) });
      }
    } else {
      socketDelivered = false;
      socketError = 'socket_not_initialized';
    }
  } catch (emitError) {
    socketDelivered = false;
    socketError = emitError?.message || String(emitError);
    console.warn('[orders] socket emit failed:', socketError);
  }

  const responseBody = order.toObject ? order.toObject() : order;
  if (archivedItems.length > 0) {
    responseBody.archivedItems = archivedItems;
  }
  // Явний прапорець для UI: якщо socketDelivered === false, клієнту слід
  // явно перепідтягнути стан (refetch), бо real-time оновлення не дійде.
  responseBody._meta = { socketDelivered, ...(socketError ? { socketError } : {}) };

  return res.status(201).json(responseBody);
}

// PATCH /:id/snapshot — admin reassigns order to a different shop
router.patch('/:id/snapshot', staffOnly, async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw appError('order_not_found');

  // Only allow reassigning active orders — reassigning fulfilled/cancelled orders
  // would incorrectly move the buyer to a new shop based on historical data
  if (!['new', 'in_progress'].includes(order.status)) {
    return res.status(409).json({
      error: 'order_not_active',
      message: `Замовлення вже ${order.status === 'fulfilled' ? 'виконано' : 'скасовано'} — перенос неможливий.`,
    });
  }

  // Hard guard: once the order is in picking pipeline, admin reassignment is forbidden.
  await ensureOrderNotInPickingPipeline(order._id);

  const { shopId } = req.body;
  if (!shopId) throw appError('order_shop_required');

  const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!shop) throw appError('order_shop_not_found');

  // Warn if target shop already has an active order from someone else — creates a new conflict.
  // $or covers legacy orders where shopId was null at creation time but buyerSnapshot.shopId was set.
  const targetConflict = await Order.findOne({
    $or: [{ shopId: shop._id }, { 'buyerSnapshot.shopId': String(shop._id) }],
    status: { $in: ['new', 'in_progress'] },
    _id: { $ne: order._id },
  }).lean();
  if (targetConflict) {
    return res.status(409).json({
      error: 'target_shop_has_order',
      message: `Магазин "${shop.name}" вже має активне замовлення. Переніс створить конфлікт. Спочатку вирішіть той конфлікт.`,
    });
  }

  const prevGroupId = order.buyerSnapshot?.deliveryGroupId
    ? String(order.buyerSnapshot.deliveryGroupId)
    : null;

  const prevSnapshot = order.buyerSnapshot
    ? { shopName: order.buyerSnapshot.shopName, shopCity: order.buyerSnapshot.shopCity }
    : null;

  // All writes (Order, PickingTask, User) must commit atomically — partial commits
  // would leave the buyer pointing at one shop while the order points at another,
  // causing phantom conflicts and stale buyerSnapshot data on the next /orders POST.
  // Всі мутації order виконуються ВСЕРЕДИНІ транзакції, щоб abort залишав
  // in-memory об'єкт незміненим і не провокував помилкових повторних збережень.
  const session = await mongoose.connection.startSession();
  let txConflict = null;
  try {
    await session.withTransaction(async () => {
      // Re-check inside the transaction to close the TOCTOU window.
      // Two admins may both pass the optimistic check above, but only one can
      // commit — the second will see the conflict here and abort cleanly.
      const conflictInTx = await Order.findOne({
        $or: [{ shopId: shop._id }, { 'buyerSnapshot.shopId': String(shop._id) }],
        status: { $in: ['new', 'in_progress'] },
        _id: { $ne: order._id },
      }).session(session).lean();
      if (conflictInTx) {
        txConflict = true;
        // Throwing a plain Error aborts the transaction without triggering a
        // TransientTransactionError retry in the Mongoose driver.
        throw Object.assign(new Error('tx_conflict'), { code: 'target_shop_has_order' });
      }

      // Re-check in transaction to close the race with the picking board.
      await ensureOrderNotInPickingPipeline(order._id, session);

      // Resolve delivery group data once inside the transaction
      let newSessionId = null;
      let warehouseZone = '';
      if (shop.deliveryGroupId) {
        const newGroup = await DeliveryGroup.findById(shop.deliveryGroupId).session(session).lean();
        if (newGroup) {
          const schedule = await getOrderingSchedule();
          newSessionId = getCurrentOrderingSessionId(String(newGroup._id), newGroup.dayOfWeek, schedule);
          warehouseZone = newGroup.name || '';
        }
      }

      // Mutate order document here so abort leaves the in-memory object untouched
      if (!order.buyerSnapshot) order.buyerSnapshot = {};
      order.buyerSnapshot.shopId = String(shop._id);
      order.buyerSnapshot.shopName = shop.name || '';
      order.buyerSnapshot.shopCity = shop.cityId?.name || '';
      order.buyerSnapshot.deliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';
      order.shopId = shop._id;
      if (newSessionId) order.orderingSessionId = newSessionId;
      order.markModified('buyerSnapshot');
      order.history.push({
        ...actorFromReq(req),
        action: 'shop_reassigned',
        meta: { from: prevSnapshot, to: { shopName: shop.name || '', shopCity: shop.cityId?.name || '' } },
      });

      await order.save({ session });

      // Sync shopName in any active PickingTask items that reference this order.
      // Failure here MUST abort the transaction — picking workers would otherwise
      // see a stale shop name on items they're packing.
      await PickingTask.updateMany(
        { 'items.orderId': order._id, status: { $in: ['pending', 'locked'] } },
        { $set: { 'items.$[elem].shopName': shop.name || '' } },
        { arrayFilters: [{ 'elem.orderId': order._id }], session },
      );

      // Update the buyer: move them to the new shop with the FULL set of derived
      // fields (shopName/shopCity/deliveryGroupId/warehouseZone) so legacy fallbacks
      // never read stale values, and clear their cart since the active order moved.
      if (order.buyerTelegramId) {
        const buyerUser = await User.findOne({ telegramId: order.buyerTelegramId }).session(session).lean();
        const userUpdate = {
          shopId: shop._id,
          deliveryGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : '',
          'cartState.orderItems': {},
          'cartState.orderItemIds': [],
          'cartState.updatedAt': new Date(),
          'cartState.reservedForGroupId': null,
        };
        if (buyerUser?.role === 'seller') {
          userUpdate.warehouseZone = warehouseZone;
        }
        await User.updateOne(
          { telegramId: order.buyerTelegramId },
          { $set: userUpdate },
          { session },
        );
      }
    });
  } finally {
    session.endSession();
  }

  if (txConflict) {
    return res.status(409).json({
      error: 'target_shop_has_order',
      message: `Магазин "${shop.name}" вже має активне замовлення. Переніс створить конфлікт. Спочатку вирішіть той конфлікт.`,
    });
  }

  // Notify picking dashboards: both the old group and the new group need to refresh
  try {
    const io = getIO();
    if (io) {
      const newGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : null;
      if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
      if (newGroupId && newGroupId !== prevGroupId) io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
      if (order.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: order.buyerTelegramId });
      io.emit('delivery_groups_updated');
    }
  } catch (emitError) {
    console.warn('[orders.snapshot] socket emit failed:', emitError?.message || emitError);
  }

  res.json(order);
});

// POST /:id/stale/restore-to-cart — admin-only action.
// Restores stale order items to seller cart and expires the order in one transaction.
router.post('/:id/stale/restore-to-cart', telegramAuth, adminOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) throw appError('order_not_found');
      if (!['new', 'in_progress'].includes(order.status)) {
        throw appError('order_not_active', { status: order.status });
      }

      await ensureOrderIsStale(order, session);
      await ensureOrderNotLockedByWarehouse(order._id, session);

      const buyerTelegramId = String(order.buyerTelegramId || '');
      if (!buyerTelegramId) throw appError('validation_failed', { field: 'buyerTelegramId' });

      const buyer = await User.findOne({ telegramId: buyerTelegramId }).session(session);
      if (!buyer) throw appError('user_not_found');

      const cartItems = buyer.cartState?.orderItems instanceof Map
        ? Object.fromEntries(buyer.cartState.orderItems)
        : { ...(buyer.cartState?.orderItems || {}) };
      const orderItemIds = new Set(Array.isArray(buyer.cartState?.orderItemIds) ? buyer.cartState.orderItemIds.map(String) : []);

      let restoredPositions = 0;
      for (const item of order.items || []) {
        if (item.cancelled) continue;
        const pid = String(item.productId || '');
        const qty = Number(item.quantity || 0);
        if (!pid || qty <= 0) continue;
        restoredPositions += 1;
        cartItems[pid] = Number(cartItems[pid] || 0) + qty;
        orderItemIds.add(pid);
      }

      await User.updateOne(
        { _id: buyer._id },
        {
          $set: {
            'cartState.orderItems': cartItems,
            'cartState.orderItemIds': Array.from(orderItemIds),
            'cartState.updatedAt': new Date(),
            'cartState.lastOrderPositions': restoredPositions,
            'cartState.reservedForGroupId': order.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : null,
          },
        },
        { session },
      );

      await detachOrderFromPendingTasks(order._id, session);

      order.status = 'expired';
      order.history.push({
        ...actorFromReq(req),
        action: 'stale_order_restored_to_cart',
        meta: {
          restoredPositions,
          deliveryGroupId: order.buyerSnapshot?.deliveryGroupId || '',
          fromSessionId: order.orderingSessionId || '',
        },
      });
      await order.save({ session });

      await User.updateOne(
        { _id: buyer._id },
        {
          $push: {
            history: {
              at: new Date(),
              ...actorFromReq(req),
              action: 'stale_order_restored_to_cart',
              meta: {
                orderId: String(order._id),
                orderNumber: order.orderNumber || null,
                restoredPositions,
                shopName: order.buyerSnapshot?.shopName || '',
                shopCity: order.buyerSnapshot?.shopCity || '',
              },
            },
          },
        },
        { session },
      );

      result = {
        orderId: String(order._id),
        buyerTelegramId,
        deliveryGroupId: order.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '',
        restoredPositions,
      };
    });
  } finally {
    session.endSession();
  }

  try {
    const io = getIO();
    if (io) {
      io.emit('user_order_updated', { buyerTelegramId: result.buyerTelegramId });
      const groupId = result.deliveryGroupId || null;
      if (groupId) io.to(`picking_group_${String(groupId)}`).emit('shop_status_changed', { groupId: String(groupId) });
      io.emit('delivery_groups_updated');
    }
  } catch (emitErr) {
    console.warn('[orders.stale.restore] socket emit failed:', emitErr?.message || emitErr);
  }

  res.json({ message: 'Замовлення повернуто в кошик продавця', ...result });
}));

// POST /:id/stale/expire — admin-only action.
// Expires stale order and detaches it from pending picking tasks.
router.post('/:id/stale/expire', telegramAuth, adminOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) throw appError('order_not_found');
      if (!['new', 'in_progress'].includes(order.status)) {
        throw appError('order_not_active', { status: order.status });
      }

      await ensureOrderIsStale(order, session);
      await ensureOrderNotLockedByWarehouse(order._id, session);
      await detachOrderFromPendingTasks(order._id, session);

      order.status = 'expired';
      order.history.push({
        ...actorFromReq(req),
        action: 'stale_order_expired_by_admin',
        meta: {
          deliveryGroupId: order.buyerSnapshot?.deliveryGroupId || '',
          fromSessionId: order.orderingSessionId || '',
        },
      });
      await order.save({ session });

      result = {
        orderId: String(order._id),
        buyerTelegramId: String(order.buyerTelegramId || ''),
        deliveryGroupId: order.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '',
      };
    });
  } finally {
    session.endSession();
  }

  try {
    const io = getIO();
    if (io) {
      if (result.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: result.buyerTelegramId });
      if (result.deliveryGroupId) {
        io.to(`picking_group_${result.deliveryGroupId}`).emit('shop_status_changed', { groupId: result.deliveryGroupId });
      }
      io.emit('delivery_groups_updated');
    }
  } catch (emitErr) {
    console.warn('[orders.stale.expire] socket emit failed:', emitErr?.message || emitErr);
  }

  res.json({ message: 'Старе замовлення закрито', ...result });
}));

router.patch('/:id', requireOrderingWindowOpen, async (req, res) => {
  throw appError('order_status_change_disabled');
});

module.exports = router;
