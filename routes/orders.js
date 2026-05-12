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
const { appError } = require('../utils/errors');

const router = express.Router();
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

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

    const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
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
  const allGroups = await DeliveryGroup.find().lean();
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
    const order = await Order.findById(req.params.id);
    if (!order) return next(appError('order_not_found'));

    const prevStatus = order.status;
    order.status = 'fulfilled';
    order.history.push({ ...actorFromReq(req), action: 'status_changed', meta: { from: prevStatus, to: 'fulfilled' } });
    await order.save();
    res.json(order);
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

router.post('/', async (req, res) => {
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
  if (buyer.role === 'seller' || buyer.role === 'admin') {
    shop = await Shop.findById(buyer.shopId).populate('cityId', 'name').lean();
    if (!shop || !shop.deliveryGroupId) {
      return res.status(403).json({
        error: 'no_delivery_group',
        message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      });
    }
    group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    if (!group) {
      return res.status(403).json({
        error: 'delivery_group_not_found',
        message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      });
    }
    schedule = await getOrderingSchedule();
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

  // Guard: sellers cannot order products that are not placed in any block.
  // Such products have no physical location on the warehouse floor.
  if (buyer.role === 'seller') {
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
    // Seller: merge only THIS seller's orders for this shop within the active ordering session
    currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery['buyerSnapshot.shopId'] = buyer.shopId;
    existingOrderQuery.orderingSessionId = currentSessionId;
  } else {
    // Admin / warehouse: no session concept — use 3-day fallback per buyer
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery.createdAt = { $gte: threeDaysAgo };
  }

  // Build buyerSnapshot — reflects the shop at the moment of the order
  const buyerSnapshot = group ? {
    shopId: buyer.shopId || null,
    shopName: shop?.name || buyer.shopName || '',
    shopCity: shop?.cityId?.name || '',
    shopAddress: buyer.shopAddress || '',
    deliveryGroupId: String(group._id),
  } : {
    shopId: buyer.shopId || null,
    shopName: buyer.shopName || '',
    shopCity: buyer.shopCity || '',
    shopAddress: buyer.shopAddress || '',
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

  res.status(201).json(responseBody);
});

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

  const { shopId } = req.body;
  if (!shopId) throw appError('order_shop_required');

  const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!shop) throw appError('order_shop_not_found');

  // Warn if target shop already has an active order from someone else — creates a new conflict
  const targetConflict = await Order.findOne({
    shopId: shop._id,
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

  if (!order.buyerSnapshot) order.buyerSnapshot = {};
  order.buyerSnapshot.shopId = String(shop._id);
  order.buyerSnapshot.shopName = shop.name || '';
  order.buyerSnapshot.shopCity = shop.cityId?.name || '';
  order.buyerSnapshot.deliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';

  // Also update the primary shopId field so queries/grouping reflect the reassignment
  order.shopId = shop._id;

  // Update orderingSessionId if the new shop belongs to a different delivery group
  if (shop.deliveryGroupId) {
    const newGroup = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    if (newGroup) {
      const schedule = await getOrderingSchedule();
      const newSessionId = getCurrentOrderingSessionId(String(newGroup._id), newGroup.dayOfWeek, schedule);
      order.orderingSessionId = newSessionId;
    }
  }

  order.markModified('buyerSnapshot');
  order.history.push({
    ...actorFromReq(req),
    action: 'shop_reassigned',
    meta: { from: prevSnapshot, to: { shopName: shop.name || '', shopCity: shop.cityId?.name || '' } },
  });

  // All writes (Order, PickingTask, User) must commit atomically — partial commits
  // would leave the buyer pointing at one shop while the order points at another,
  // causing phantom conflicts and stale buyerSnapshot data on the next /orders POST.
  let warehouseZone = '';
  if (shop.deliveryGroupId) {
    const newGroup = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    warehouseZone = newGroup?.name || '';
  }

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
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
          shopName: shop.name || '',
          shopCity: shop.cityId?.name || '',
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

router.patch('/:id', requireOrderingWindowOpen, async (req, res) => {
  const telegramId = req.telegramId;
  const user = req.telegramUser;

  const allowedFields = ['status'];
  const update = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (!Object.keys(update).length) {
    throw appError('order_no_fields');
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw appError('order_not_found');

  const isOwner = order.buyerTelegramId === telegramId;
  const isStaff = ['admin', 'warehouse'].includes(user.role);
  if (!isOwner && !isStaff) {
    throw appError('order_modify_forbidden');
  }

  if (isOwner && !isStaff && update.status) {
    throw appError('order_seller_no_status');
  }

  if (update.status === 'cancelled' && order.status !== 'cancelled') {
    console.error('[orders.patch] cancelling order', order._id, 'currentStatus=', order.status, 'update=', update);
    for (const item of order.items) {
      if (!item.packed && !item.cancelled) {
        item.cancelled = true;
      }
    }
  }

  const prevStatus = order.status;
  order.history.push({ ...actorFromReq(req), action: 'status_changed', meta: { from: prevStatus, to: update.status } });
  order.status = update.status;
  await order.save();
  res.json(order);
});

module.exports = router;
