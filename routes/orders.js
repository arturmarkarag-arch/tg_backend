const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const RegistrationRequest = require('../models/RegistrationRequest');
const { sendOrderConfirmation } = require('../telegramBot');
const { getTelegramAuth } = require('../utils/validateTelegramInitData');
const { telegramAuth } = require('../middleware/telegramAuth');

const router = express.Router();

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
    const buyer = buyerMap.get(order.buyerTelegramId);
    if (buyer) {
      obj.buyer = {
        telegramId: buyer.telegramId,
        shopName: buyer.shopName,
        shopAddress: buyer.shopAddress,
        shopCity: buyer.shopCity,
        firstName: buyer.firstName,
        lastName: buyer.lastName,
        phoneNumber: buyer.phoneNumber,
      };
    }
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
  if (buyer) {
    obj.buyer = {
      telegramId: buyer.telegramId,
      shopName: buyer.shopName,
      shopAddress: buyer.shopAddress,
      shopCity: buyer.shopCity,
      firstName: buyer.firstName,
      lastName: buyer.lastName,
      phoneNumber: buyer.phoneNumber,
    };
  }
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
    const pendingRequest = await RegistrationRequest.findOne({ telegramId, status: 'pending' }).lean();
    if (pendingRequest) {
      return res.status(403).json({ error: 'pending_registration', message: 'Ваша заявка на реєстрацію очікує підтвердження' });
    }
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

  const productIds = items
    .map((item) => item?.productId)
    .filter(Boolean)
    .map(String);

  const realProducts = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(realProducts.map((product) => [String(product._id), product]));

  let totalPrice = 0;
  const validItems = [];

  for (const item of items) {
    const productId = String(item?.productId || '');
    const product = productMap.get(productId);
    if (!product) continue;
    if (!isProductAvailable(product)) continue;

    const quantity = Math.min(1000, Math.max(1, parseInt(item.quantity, 10) || 1));
    if (quantity <= 0) continue;

    const price = Number(product.price || 0);

    validItems.push({
      productId: product._id,
      name: product.title || product.name || 'Товар',
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

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const existingOrder = await Order.findOne({
    buyerTelegramId: buyer.telegramId,
    status: { $in: ['new', 'in_progress'] },
    createdAt: { $gte: threeDaysAgo },
  });

  let order;

  try {
    if (existingOrder) {
      for (const newItem of validItems) {
        const sameItem = existingOrder.items.find((i) => String(i.productId) === String(newItem.productId));
        if (sameItem) {
          sameItem.quantity += newItem.quantity;
          sameItem.packed = false;
          sameItem.cancelled = false;
        } else {
          existingOrder.items.push(newItem);
        }
      }

      existingOrder.totalPrice = existingOrder.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0);
      if (existingOrder.status === 'new' || existingOrder.status === 'in_progress') {
        existingOrder.status = 'in_progress';
      }
      await existingOrder.save();
      order = existingOrder;
    } else {
      order = new Order({
        buyerTelegramId: buyer.telegramId,
        items: validItems,
        shippingAddress,
        contactInfo,
        emojiType,
        totalPrice,
        ...(sanitizedKey ? { idempotencyKey: sanitizedKey } : {}),
      });
      await order.save();
    }
  } catch (error) {
    throw error;
  }

  sendOrderConfirmation(order.buyerTelegramId, validItems.length, totalPrice, order._id.toString()).catch((err) => {
    console.error('Failed to send order confirmation:', err?.message || err);
  });

  res.status(201).json(order);
});

router.patch('/:id', async (req, res) => {
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

  if (isOwner && update.status && update.status !== 'cancelled') {
    return res.status(403).json({ error: 'Buyers can only cancel their own orders' });
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
