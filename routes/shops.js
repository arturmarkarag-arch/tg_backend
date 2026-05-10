const express = require('express');
const Shop = require('../models/Shop');
const City = require('../models/City');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');

const router = express.Router();

// ─── GET /api/shops ──────────────────────────────────────────────────────────
// Список магазинів. За замовчуванням тільки активні.
// Query: ?cityId=xxx  ?city=Warszawa (legacy)  ?deliveryGroupId=xxx  ?includeInactive=true
router.get('/', async (req, res) => {
  try {
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

    // Кількість продавців по кожному магазину
    const shopIds = shops.map((s) => s._id); // ObjectId array
    const sellerCounts = await User.aggregate([
      { $match: { role: 'seller', shopId: { $in: shopIds } } },
      { $group: { _id: '$shopId', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    for (const row of sellerCounts) countMap[String(row._id)] = row.count;

    const result = shops.map((s) => ({
      ...s,
      cityId: s.cityId?._id ? String(s.cityId._id) : (s.cityId || null),
      city: s.cityId?.name || '',
      sellerCount: countMap[String(s._id)] || 0,
    }));

    res.json(result);
  } catch (err) {
    console.error('[GET /shops]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/shops/cities ────────────────────────────────────────────────────
// Публічний список міст (для реєстрації та seller)
router.get('/cities', async (req, res) => {
  try {
    const cities = await City.find().sort({ name: 1 }).lean();
    res.json(cities);
  } catch (err) {
    console.error('[GET /shops/cities]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/shops/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).populate('cityId', 'name country').lean();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    // Продавці цього магазину
    const sellers = await User.find({ shopId: shop._id, role: 'seller' })
      .select('telegramId firstName lastName')
      .lean();

    const cityId = shop.cityId?._id ? String(shop.cityId._id) : (shop.cityId || null);
    res.json({ ...shop, cityId, city: shop.cityId?.name || '', sellers });
  } catch (err) {
    console.error('[GET /shops/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/shops ──────────────────────────────────────────────────────────
router.post('/', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const { name, cityId, deliveryGroupId, address } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name є обовʼязковим' });
    }
    if (!cityId) {
      return res.status(400).json({ error: 'cityId є обовʼязковим' });
    }
    if (!deliveryGroupId) {
      return res.status(400).json({ error: 'deliveryGroupId є обовʼязковим' });
    }

    const cityDoc = await City.findById(cityId).lean();
    if (!cityDoc) return res.status(400).json({ error: 'Місто не знайдено' });
    const group = await DeliveryGroup.findById(deliveryGroupId).lean();
    if (!group) return res.status(400).json({ error: 'Групу доставки не знайдено' });

    const shop = await Shop.create({
      name: String(name).trim(),
      cityId: cityDoc._id,
      city: cityDoc.name,
      deliveryGroupId: deliveryGroupId ? String(deliveryGroupId) : '',
      address: address ? String(address).trim() : '',
    });

    res.status(201).json(shop);
  } catch (err) {
    console.error('[POST /shops]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/shops/:id ─────────────────────────────────────────────────────
router.patch('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const { name, cityId, deliveryGroupId, address, isActive } = req.body;

    if (name !== undefined) shop.name = String(name).trim();
    if (address !== undefined) shop.address = String(address).trim();
    if (isActive !== undefined) shop.isActive = Boolean(isActive);

    if (cityId !== undefined) {
      const cityDoc = await City.findById(cityId).lean();
      if (!cityDoc) return res.status(400).json({ error: 'Місто не знайдено' });
      shop.cityId = cityDoc._id;
      shop.city = cityDoc.name;
    }

    if (deliveryGroupId !== undefined) {
      if (deliveryGroupId) {
        const group = await DeliveryGroup.findById(deliveryGroupId).lean();
        if (!group) return res.status(400).json({ error: 'Групу доставки не знайдено' });
      }
      shop.deliveryGroupId = deliveryGroupId ? String(deliveryGroupId) : '';
    }

    await shop.save();
    res.json(shop);
  } catch (err) {
    console.error('[PATCH /shops/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/shops/:id ────────────────────────────────────────────────────
// Видаляємо тільки якщо 0 продавців прив'язано
router.delete('/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).lean();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const sellerCount = await User.countDocuments({ shopId: String(shop._id), role: 'seller' });
    if (sellerCount > 0) {
      return res.status(400).json({
        error: `Не можна видалити магазин: ${sellerCount} продавець(ів) прив'язано. Спочатку зніміть їх у налаштуваннях магазину.`,
      });
    }

    await Shop.findByIdAndDelete(req.params.id);
    res.json({ message: 'Магазин видалено' });
  } catch (err) {
    console.error('[DELETE /shops/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/shops/:id/sellers ─────────────────────────────────────────────
// Масове оновлення продавців магазину (знімаємо/додаємо через список telegramId)
// Body: { sellers: ['111', '222'] } — повний новий список продавців магазину
router.patch('/:id/sellers', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.id).lean();
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

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
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Продавців не знайдено: ${invalid.join(', ')}` });
      }
    }

    // Знімаємо з магазину тих, кого прибрали зі списку
    const toRemove = currentIds.filter((id) => !newSellers.includes(id));
    if (toRemove.length > 0) {
      await User.updateMany({ telegramId: { $in: toRemove } }, { $set: { shopId: null } });
    }

    // Призначаємо магазин новим продавцям
    const toAdd = newSellers.filter((id) => !currentIds.includes(id));
    if (toAdd.length > 0) {
      await User.updateMany({ telegramId: { $in: toAdd }, role: 'seller' }, { $set: { shopId: shopIdStr } });
    }

    // Повертаємо оновлений список
    const updatedSellers = await User.find({ shopId: shopIdStr, role: 'seller' })
      .select('telegramId firstName lastName')
      .lean();

    res.json({ sellers: updatedSellers });
  } catch (err) {
    console.error('[PATCH /shops/:id/sellers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
