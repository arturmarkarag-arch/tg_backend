const express = require('express');
const Order = require('../models/Order');
const User = require('../models/User');
const RegistrationRequest = require('../models/RegistrationRequest');
const { sendOrderConfirmation } = require('../telegramBot');
const { validateTelegramInitData, getTelegramId, getTelegramAuth } = require('../utils/validateTelegramInitData');

const router = express.Router();

router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const status = req.query.status; // optional: 'new', 'confirmed', 'fulfilled', 'cancelled'
  const buyerTelegramId = req.query.buyerTelegramId;

  const filter = {};
  if (buyerTelegramId) {
    filter.buyerTelegramId = buyerTelegramId;
  }
  if (status && status !== 'all') {
    filter.status = status;
  } else if (!status) {
    // By default exclude cancelled
    filter.status = { $ne: 'cancelled' };
  }

  const total = await Order.countDocuments(filter);
  const orders = await Order.find(filter)
    .populate('items.productId')
    .sort({ createdAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);

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
    pageCount: Math.ceil(total / pageSize),
  });
});

router.get('/:id', async (req, res) => {
  const order = await Order.findById(req.params.id).populate('items.productId');
  if (!order) return res.status(404).json({ error: 'Order not found' });
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
  const { initData, buyerTelegramId, items, shippingAddress, contactInfo, emojiType } = req.body;
  let telegramId = buyerTelegramId;

  if (!telegramId && initData) {
    const validation = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.valid) {
      return res.status(401).json({ error: validation.error || 'Invalid initData' });
    }
    telegramId = validation.telegramId;
  }

  if (!telegramId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'buyerTelegramId or valid initData and items are required' });
  }

  telegramId = String(telegramId);
  const buyer = await User.findOne({ telegramId }).lean();
  if (!buyer) {
    const pendingRequest = await RegistrationRequest.findOne({ telegramId, status: 'pending' }).lean();
    if (pendingRequest) {
      return res.status(403).json({ error: 'pending_registration', message: 'Ваша заявка на реєстрацію очікує підтвердження' });
    }
    return res.status(403).json({ error: 'not_registered', message: 'Потрібно завершити реєстрацію, перш ніж робити замовлення' });
  }

  const totalPrice = items.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
  const order = new Order({ buyerTelegramId: buyer.telegramId, items, shippingAddress, contactInfo, emojiType, totalPrice });
  await order.save();

  sendOrderConfirmation(order.buyerTelegramId, items.length, totalPrice, order._id.toString()).catch((err) => {
    console.error('Failed to send order confirmation:', err?.message || err);
  });

  res.status(201).json(order);
});

router.patch('/:id', async (req, res) => {
  // Only allow updating specific safe fields
  const allowedFields = ['status'];
  const update = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (!Object.keys(update).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  const order = await Order.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

module.exports = router;
