const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const Shop = require('../models/Shop');
const City = require('../models/City');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const Order = require('../models/Order');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();

// ─── GET /api/shops ──────────────────────────────────────────────────────────
// Список магазинів. За замовчуванням тільки активні.
// Query: ?cityId=xxx  ?city=Warszawa (legacy)  ?deliveryGroupId=xxx  ?includeInactive=true
router.get('/', asyncHandler(async (req, res) => {
  const filter = {};

    if (req.query.includeInactive !== 'true') {
      filter.isActive = true;
    }
    if (req.query.cityId) {
      filter.cityId = req.query.cityId;
    } else if (req.query.city) {
      // Legacy string filter — resolve to cityId
      const cityDoc = await City.findOne({ name: req.query.city.trim() }).lean();
      if (cityDoc) filter.cityId = cityDoc._id;
      else filter.city = req.query.city.trim(); // fallback
    }
    if (req.query.deliveryGroupId) {
      filter.deliveryGroupId = req.query.deliveryGroupId;
    }

    const shops = await Shop.find(filter).populate('cityId', 'name country').sort({ city: 1, name: 1 }).lean();

    // Seller names per shop
    const shopIds = shops.map((s) => s._id);
    const sellers = await User.find({ role: 'seller', shopId: { $in: shopIds } })
      .select('shopId firstName lastName telegramId')
      .lean();
    const sellersByShop = {};
    for (const s of sellers) {
      const sid = String(s.shopId);
      if (!sellersByShop[sid]) sellersByShop[sid] = [];
      sellersByShop[sid].push([s.firstName, s.lastName].filter(Boolean).join(' ') || String(s.telegramId));
    }

    // Active order flags — only when filtered by deliveryGroupId (for reassign modal)
    const activeOrderShopIds = new Set();
    if (req.query.deliveryGroupId) {
      const activeOrders = await Order.find({
        status: { $in: ['new', 'in_progress'] },
        'buyerSnapshot.deliveryGroupId': req.query.deliveryGroupId,
      }).select('shopId').lean();
      for (const o of activeOrders) {
        if (o.shopId) activeOrderShopIds.add(String(o.shopId));
      }
    }

    const result = shops.map((s) => {
      const sid = String(s._id);
      const shopSellerNames = sellersByShop[sid] || [];
      return {
        ...s,
        cityId: s.cityId?._id ? String(s.cityId._id) : (s.cityId || null),
        city: s.cityId?.name || '',
        sellerCount: shopSellerNames.length,
        sellerNames: shopSellerNames,
        hasActiveOrder: activeOrderShopIds.has(sid),
      };
    });

    res.json(result);
}));

// ─── GET /api/shops/cities ────────────────────────────────────────────────────
// Публічний список міст (для реєстрації та seller)
router.get('/cities', asyncHandler(async (req, res) => {
  const cities = await City.find().sort({ name: 1 }).lean();
  res.json(cities);
}));

// ─── GET /api/shops/:id ───────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id).populate('cityId', 'name country').lean();
  if (!shop) throw appError('shop_not_found');

  // Продавці цього магазину
  const sellers = await User.find({ shopId: shop._id, role: 'seller' })
    .select('telegramId firstName lastName')
    .lean();

  const cityId = shop.cityId?._id ? String(shop.cityId._id) : (shop.cityId || null);
  res.json({ ...shop, cityId, city: shop.cityId?.name || '', sellers });
}));

// ─── POST /api/shops ──────────────────────────────────────────────────────────
router.post('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { name, cityId, deliveryGroupId, address } = req.body;

  if (!name || !String(name).trim()) throw appError('shop_name_required');
  if (!cityId) throw appError('shop_city_required');
  if (!deliveryGroupId) throw appError('shop_delivery_group_required');

  const cityDoc = await City.findById(cityId).lean();
  if (!cityDoc) throw appError('shop_city_not_found');
  const group = await DeliveryGroup.findById(deliveryGroupId).lean();
  if (!group) throw appError('shop_delivery_group_not_found');

  const shop = await Shop.create({
    name: String(name).trim(),
    cityId: cityDoc._id,
    city: cityDoc.name,
    deliveryGroupId: deliveryGroupId ? String(deliveryGroupId) : '',
    address: address ? String(address).trim() : '',
  });

  res.status(201).json(shop);
}));

// ─── PATCH /api/shops/:id ─────────────────────────────────────────────────────
router.patch('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id);
  if (!shop) throw appError('shop_not_found');

  const { name, cityId, deliveryGroupId, address, isActive } = req.body;

  if (name !== undefined) shop.name = String(name).trim();
  if (address !== undefined) shop.address = String(address).trim();
  if (isActive !== undefined) shop.isActive = Boolean(isActive);

  if (cityId !== undefined) {
    const cityDoc = await City.findById(cityId).lean();
    if (!cityDoc) throw appError('shop_city_not_found');
    shop.cityId = cityDoc._id;
    shop.city = cityDoc.name;
  }

  if (deliveryGroupId !== undefined) {
    if (deliveryGroupId) {
      const group = await DeliveryGroup.findById(deliveryGroupId).lean();
      if (!group) throw appError('shop_delivery_group_not_found');
    }
    shop.deliveryGroupId = deliveryGroupId ? String(deliveryGroupId) : '';
  }

  await shop.save();
  res.json(shop);
}));

// ─── DELETE /api/shops/:id ────────────────────────────────────────────────────
// Видаляємо тільки якщо 0 продавців прив'язано
router.delete('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Wrap check + delete in a transaction so a seller or active order created
  // between the count and the delete cannot leave us with orphan references.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const shop = await Shop.findById(req.params.id).session(session);
      if (!shop) throw appError('shop_not_found');

      const sellerCount = await User.countDocuments({
        shopId: String(shop._id),
        role: 'seller',
      }).session(session);
      if (sellerCount > 0) throw appError('shop_has_sellers', { sellerCount });

      const activeOrders = await Order.countDocuments({
        shopId: shop._id,
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (activeOrders > 0) throw appError('shop_has_active_orders', { activeOrders });

      await Shop.deleteOne({ _id: shop._id }, { session });
      result = { message: 'Магазин видалено' };
    });
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

// ─── PATCH /api/shops/:id/sellers ─────────────────────────────────────────────
// Масове оновлення продавців магазину (знімаємо/додаємо через список telegramId)
// Body: { sellers: ['111', '222'] } — повний новий список продавців магазину
router.patch('/:id/sellers', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id).lean();
  if (!shop) throw appError('shop_not_found');

  const newSellers = Array.isArray(req.body.sellers)
    ? req.body.sellers.map((id) => String(id).trim()).filter(Boolean)
    : [];

  const shopIdStr = String(shop._id);

  // Поточні продавці цього магазину
  const currentSellers = await User.find({ shopId: shopIdStr, role: 'seller' })
    .select('telegramId')
    .lean();
  const currentIds = currentSellers.map((u) => u.telegramId);

  // Валідуємо нових продавців
  if (newSellers.length > 0) {
    const validUsers = await User.find({
      telegramId: { $in: newSellers },
      role: 'seller',
    }).distinct('telegramId');
    const invalid = newSellers.filter((id) => !validUsers.includes(id));
    if (invalid.length > 0) throw appError('shop_sellers_invalid', { ids: invalid });
  }

  // Знімаємо/призначаємо в одній транзакції — інакше при збої між
  // двома updateMany частина продавців може опинитися «у підвішеному стані»
  // (вже знятий зі старого, ще не призначений у новий).
  const toRemove = currentIds.filter((id) => !newSellers.includes(id));
  const toAdd = newSellers.filter((id) => !currentIds.includes(id));

  if (toRemove.length > 0 || toAdd.length > 0) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (toRemove.length > 0) {
          await User.updateMany(
            { telegramId: { $in: toRemove } },
            { $set: { shopId: null } },
            { session }
          );
        }
        if (toAdd.length > 0) {
          await User.updateMany(
            { telegramId: { $in: toAdd }, role: 'seller' },
            { $set: { shopId: shopIdStr } },
            { session }
          );
        }
      });
    } finally {
      session.endSession();
    }
  }

  // Повертаємо оновлений список
  const updatedSellers = await User.find({ shopId: shopIdStr, role: 'seller' })
    .select('telegramId firstName lastName')
    .lean();

  res.json({ sellers: updatedSellers });
}));

module.exports = router;
