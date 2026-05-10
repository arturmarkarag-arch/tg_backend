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
const { getTelegramAuth } = require('../utils/validateTelegramInitData');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');
const { getIO } = require('../socket');
const { isOrderingOpen, getOrderingWindowOpenAt, getCurrentOrderingSessionId } = require('../utils/orderingSchedule');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');

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
      return res.status(403).json({ error: 'You may only query your own orders' });
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
    res.status(500).json({ error: 'Failed to fetch transit orders' });
  }
});

router.post('/:id/fulfill', telegramAuth, staffOnly, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });

    order.status = 'fulfilled';
    await order.save();
    res.json(order);
  } catch (error) {
    console.error('[orders.fulfill] Error:', error);
    res.status(500).json({ error: 'Failed to fulfill order' });
  }
});

router.get('/:id', async (req, res) => {
  const telegramId = req.telegramId;
  const authUser = req.telegramUser;

  const order = await Order.findById(req.params.id).populate('items.productId');
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (String(order.buyerTelegramId) !== telegramId && !['admin', 'warehouse'].includes(authUser.role)) {
    return res.status(403).json({ error: 'You do not have permission to view this order' });
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
    return res.status(401).json({ error: validation.error || 'Invalid or missing initData' });
  }

  const telegramId = String(validation.telegramId || '');
  if (!telegramId) {
    return res.status(401).json({ error: 'Invalid initData' });
  }

  if (buyerTelegramId && String(buyerTelegramId) !== telegramId) {
    return res.status(403).json({ error: 'buyerTelegramId does not match authenticated user' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Valid items are required' });
  }

  const buyer = await User.findOne({ telegramId }).lean();
  if (!buyer) {
    return res.status(403).json({ error: 'not_registered', message: 'Потрібно завершити реєстрацію, перш ніж робити замовлення' });
  }

  // Idempotency: if a key was provided and an order already exists for it, return it immediately
  const sanitizedKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  if (sanitizedKey) {
    const existingByKey = await Order.findOne({ idempotencyKey: sanitizedKey });
    if (existingByKey) {
      return res.status(200).json(existingByKey);
    }
  }

  // Check ordering window — sellers AND admins with a shopId go through the full session flow.
  // admin without shopId and warehouse users are unrestricted (3-day fallback below).
  // shop, group and schedule are kept in outer scope so the merge logic can use them below
  let shop = null;
  let group = null;
  let schedule = null;
  if (buyer.role === 'seller' || (buyer.role === 'admin' && buyer.shopId)) {
    if (!buyer.shopId) {
      return res.status(403).json({
        error: 'no_shop',
        message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      });
    }
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
    return res.status(400).json({ error: 'No valid items found' });
  }

  // Build existingOrder query: sellers merge per SHOP within the current ordering session.
  // admin/warehouse fall back to a 3-day per-buyer window.
  const existingOrderQuery = {
    status: { $in: ['new', 'in_progress'] },
  };
  let currentSessionId = '';
  if (group && schedule) {
    // Seller: merge all orders for this shop within the active ordering session
    currentSessionId = getCurrentOrderingSessionId(String(group._id), group.dayOfWeek, schedule);
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
      });
      await order.save({ session: mongoSession });
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

  // Save order position count so SettingsPage can display it without extra queries
  const activePositions = (order.items || []).filter((i) => !i.cancelled).length;
  if (buyer.shopId) {
    await Shop.updateOne(
      { _id: buyer.shopId },
      { $set: { 'cartState.lastOrderPositions': activePositions } }
    ).catch((e) => console.warn('[orders] lastOrderPositions update failed:', e?.message));
  }

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
    }
  } catch (emitError) {
    console.warn('[orders] socket emit failed:', emitError?.message || emitError);
  }

  const responseBody = order.toObject ? order.toObject() : order;
  if (archivedItems.length > 0) {
    responseBody.archivedItems = archivedItems;
  }

  res.status(201).json(responseBody);
});

// PATCH /:id/snapshot — admin reassigns order to a different shop
router.patch('/:id/snapshot', staffOnly, async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { shopId } = req.body;
  if (!shopId) return res.status(400).json({ error: 'shopId is required' });

  const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!shop) return res.status(400).json({ error: 'Магазин не знайдено' });

  if (!order.buyerSnapshot) order.buyerSnapshot = {};
  order.buyerSnapshot.shopId = String(shop._id);
  order.buyerSnapshot.shopName = shop.name || '';
  order.buyerSnapshot.shopCity = shop.cityId?.name || '';
  order.buyerSnapshot.deliveryGroupId = shop.deliveryGroupId || '';

  order.markModified('buyerSnapshot');
  await order.save();

  // Sync shopName in any active PickingTask items that reference this order.
  // This ensures warehouse workers see the correct shop name if picking is already in progress.
  await PickingTask.updateMany(
    { 'items.orderId': order._id, status: { $in: ['pending', 'locked'] } },
    { $set: { 'items.$[elem].shopName': shop.name || '' } },
    { arrayFilters: [{ 'elem.orderId': order._id }] },
  );

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
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const isOwner = order.buyerTelegramId === telegramId;
  const isStaff = ['admin', 'warehouse'].includes(user.role);
  if (!isOwner && !isStaff) {
    return res.status(403).json({ error: 'You do not have permission to modify this order' });
  }

  if (isOwner && !isStaff && update.status) {
    return res.status(403).json({ error: 'Sellers cannot change order status' });
  }

  if (update.status === 'cancelled' && order.status !== 'cancelled') {
    console.error('[orders.patch] cancelling order', order._id, 'currentStatus=', order.status, 'update=', update);
    for (const item of order.items) {
      if (!item.packed && !item.cancelled) {
        item.cancelled = true;
      }
    }
  }

  order.status = update.status;
  await order.save();
  res.json(order);
});

module.exports = router;
