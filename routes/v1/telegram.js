const express = require('express');
const { validateTelegramInitData, getInitDataFromRequest, getTelegramId, getTelegramAuth } = require('../../utils/validateTelegramInitData');
const { DAY_SHORT } = require('../../utils/dayNames');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const DeliveryGroup = require('../../models/DeliveryGroup');
const Shop = require('../../models/Shop');
const { sendAdminNotification, sendRegistrationApprovedMessage } = require('../../telegramBot');

const router = express.Router();

function normalizeMiniAppState(miniAppState) {
  if (!miniAppState || typeof miniAppState !== 'object') return miniAppState;
  const normalized = { ...miniAppState };
  if (normalized.orderItems instanceof Map) {
    normalized.orderItems = Object.fromEntries(normalized.orderItems);
  }
  if (normalized.orderItems && typeof normalized.orderItems === 'object' && !Array.isArray(normalized.orderItems)) {
    normalized.orderItems = Object.fromEntries(Object.entries(normalized.orderItems));
  }
  return normalized;
}

async function resolveWarehouseZone(user) {
  // New architecture: shopId → shop → deliveryGroupId → group
  if (user?.shopId) {
    const shop = await Shop.findById(user.shopId).lean();
    if (shop?.deliveryGroupId) {
      const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
      return group?.name || '';
    }
  }
  // Legacy fallback
  if (!user?.deliveryGroupId) return '';
  const group = await DeliveryGroup.findById(user.deliveryGroupId).lean();
  return group?.name || '';
}

// POST /api/v1/telegram/validate — перевірити підпис initData
router.post('/validate', (req, res) => {
  const { initData } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  // Only trust parsedData.user.id — Telegram never puts id at root level
  const telegramId = parsedData.user?.id;
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  res.json({ telegramId: String(telegramId), user: parsedData.user || null });
});

// POST /api/v1/telegram/me — перевірити initData І чи є користувач у системі
// Повертає профіль якщо є, 403 якщо немає, 401 якщо initData невалідна
router.post('/me', async (req, res) => {
  const initData = getInitDataFromRequest(req);
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, parsedData, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  // 2. Шукаємо в нашій базі
  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    const pendingRequest = await RegistrationRequest.findOne({ telegramId, status: 'pending' }).lean();
    if (pendingRequest) {
      return res.status(403).json({
        error: 'pending_registration',
        telegramId,
        message: 'Ваша заявка на реєстрацію прийнята. Очікуйте підтвердження адміністратора.',
      });
    }

    const blockedRequest = await RegistrationRequest.findOne({ telegramId, status: 'blocked' }).lean();
    if (blockedRequest) {
      return res.status(403).json({
        error: 'blocked_registration',
        telegramId,
        message: 'Ваша реєстрація заблокована. Зверніться до адміністратора.',
      });
    }

    return res.status(403).json({
      error: 'not_registered',
      telegramId,
      message: 'Вас не знайдено в системі. Зверніться до адміністратора.',
    });
  }

  // 3. Повертаємо профіль (без чутливих полів)
  const userShop = user.shopId ? await Shop.findById(user.shopId).lean() : null;
  const resolvedGroupId = userShop?.deliveryGroupId || user.deliveryGroupId || '';
  res.json({
    telegramId: user.telegramId,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    shopId: userShop ? String(userShop._id) : null,
    shop: userShop ? { _id: userShop._id, name: userShop.name, city: userShop.city, deliveryGroupId: userShop.deliveryGroupId } : null,
    shopName: userShop?.name || user.shopName || '',
    shopNumber: user.shopNumber,
    shopCity: userShop?.city || user.shopCity || '',
    deliveryGroupId: resolvedGroupId,
    warehouseZone: await resolveWarehouseZone(user),
    isWarehouseManager: user.isWarehouseManager || false,
    isOnShift: user.isOnShift || false,
    shiftZone: user.shiftZone || { startBlock: null, endBlock: null },
    miniAppState: normalizeMiniAppState(user.miniAppState || {
      lastViewedProductId: '',
      currentIndex: 0,
      updatedAt: null,
    }),
  });
});

// PATCH /api/v1/telegram/me/shop — seller оновлює свій магазин
router.patch('/me/shop', async (req, res) => {
  try {
    const user = req.telegramUser;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'shopId є обовʼязковим' });

    const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
    if (!shop) return res.status(404).json({ error: 'Магазин не знайдено' });

    let warehouseZone = '';
    if (shop.deliveryGroupId) {
      const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
      warehouseZone = group?.name || '';
    }

    const shopCity = shop.cityId?.name || shop.city || '';
    const shopName = shop.name || '';
    const deliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : null;

    await User.findByIdAndUpdate(user._id, {
      shopId: shop._id,
      shopName,
      shopCity,
      deliveryGroupId: shop.deliveryGroupId || null,
      warehouseZone,
    });

    res.json({
      shopId: String(shop._id),
      shopName,
      shopCity,
      deliveryGroupId,
      warehouseZone,
    });
  } catch (err) {
    console.error('[PATCH /v1/telegram/me/shop]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/telegram/mini-app/state — зберегти останній переглянутий товар у mini app
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
router.post('/mini-app/state', async (req, res) => {
  const { currentIndex, currentPage, productId, orderItems, orderItemIds, viewMode, clientOrderId } = req.body;
  const telegramId = req.telegramId;

  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    return res.status(400).json({ error: 'currentIndex must be a non-negative integer' });
  }
  if (!Number.isInteger(currentPage) || currentPage < 0) {
    return res.status(400).json({ error: 'currentPage must be a non-negative integer' });
  }

  const sanitizedOrderItems = typeof orderItems === 'object' && orderItems !== null
    ? Object.fromEntries(Object.entries(orderItems).map(([productId, qty]) => [String(productId), Number(qty) || 0]))
    : {};
  const sanitizedOrderItemIds = Array.isArray(orderItemIds)
    ? orderItemIds.map((id) => String(id))
    : [];

  const validViewMode = viewMode === 'grid' ? 'grid' : 'carousel';
  const sanitizedClientOrderId = typeof clientOrderId === 'string' && clientOrderId.trim() ? clientOrderId.trim() : null;
  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        'miniAppState.currentIndex': currentIndex,
        'miniAppState.currentPage': currentPage,
        'miniAppState.lastViewedProductId': String(productId || ''),
        'miniAppState.orderItems': sanitizedOrderItems,
        'miniAppState.orderItemIds': sanitizedOrderItemIds,
        'miniAppState.viewMode': validViewMode,
        'miniAppState.clientOrderId': sanitizedClientOrderId,
        'miniAppState.updatedAt': new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!user) {
    const pendingRequest = await RegistrationRequest.findOne({ telegramId, status: 'pending' }).lean();
    if (pendingRequest) {
      return res.status(403).json({ error: 'pending_registration', message: 'Ваша заявка на реєстрацію очікує підтвердження' });
    }
    return res.status(403).json({ error: 'User not found' });
  }

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState) });
});

// POST /api/v1/telegram/mini-app/reset-state — очистити стан mini app
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
// POST /api/v1/telegram/mini-app/reset-state — очистити стан mini app
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
router.post('/mini-app/reset-state', async (req, res) => {
  const telegramId = req.telegramId;

  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        'miniAppState.currentIndex': 0,
        'miniAppState.lastViewedProductId': '',
        'miniAppState.orderItems': {},
        'miniAppState.orderItemIds': [],
        'miniAppState.updatedAt': new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!user) {
    const pendingRequest = await RegistrationRequest.findOne({ telegramId, status: 'pending' }).lean();
    if (pendingRequest) {
      return res.status(403).json({ error: 'pending_registration', message: 'Ваша заявка на реєстрацію очікує підтвердження' });
    }
    return res.status(403).json({ error: 'User not found' });
  }

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState) });
});

router.post('/register-request', async (req, res) => {
  const { firstName, lastName, shopId, role } = req.body;

  const { valid, parsedData, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  if (!firstName || !lastName || !role) {
    return res.status(400).json({ error: 'Будь ласка, заповніть всі обов’язкові поля' });
  }
  if (!['seller', 'warehouse'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role selected' });
  }
  if (role === 'seller' && !shopId) {
    return res.status(400).json({ error: 'Магазин є обов’язковим для продавця' });
  }

  const existingUser = await User.findOne({ telegramId }).lean();
  if (existingUser) {
    return res.status(409).json({ error: 'User already registered' });
  }

  const existingRequest = await RegistrationRequest.findOne({
    telegramId,
    status: { $in: ['pending', 'blocked'] },
  }).lean();
  if (existingRequest) {
    if (existingRequest.status === 'blocked') {
      return res.status(403).json({ error: 'Registration request blocked', message: 'Ваша реєстрація заблокована.' });
    }
    return res.status(409).json({ error: 'Registration request already exists' });
  }

  let shop = null;
  let group = null;
  if (role === 'seller') {
    shop = await Shop.findById(shopId).lean();
    if (!shop || !shop.isActive) {
      return res.status(400).json({ error: 'Магазин не знайдено' });
    }
    if (!shop.deliveryGroupId) {
      return res.status(400).json({ error: 'Магазин не прив’язаний до групи доставки' });
    }
    group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    if (!group) {
      return res.status(400).json({ error: 'Групу доставки магазину не знайдено' });
    }
  }

  const request = await RegistrationRequest.create({
    telegramId,
    firstName,
    lastName,
    shopId:          role === 'seller' ? String(shop._id) : null,
    shopName:        role === 'seller' ? shop.name        : '',
    shopCity:        role === 'seller' ? shop.city        : '',
    deliveryGroupId: role === 'seller' ? shop.deliveryGroupId : '',
    role,
    status: 'pending',
    meta: { submittedAt: new Date() },
  });

  const roleLabel = role === 'warehouse' ? 'Склад' : 'Продавець';
  const message = `📥 Нова заявка на реєстрацію (${roleLabel}):\n` +
    `Telegram ID: ${telegramId}\n` +
    `Ім’я: ${firstName}\n` +
    `Прізвище: ${lastName}\n` +
    `Роль: ${roleLabel}\n` +
    `Назва магазину: ${role === 'seller' ? shop.name : 'не вказано'}\n` +
    `Місто: ${role === 'seller' ? shop.city : 'не вказано'}\n` +
    `Група доставки: ${role === 'seller' ? `${group.name} (${DAY_SHORT[group.dayOfWeek] || 'День'})` : 'не вказано'}\n` +
    `Запит створено: ${new Date().toLocaleString()}`;

  sendAdminNotification(message, request._id.toString()).catch(() => {});

  res.status(201).json({ requestId: request._id, status: 'pending' });
});

router.get('/register-requests', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can access registration requests' });
  }

  const status = String(req.query.status || 'pending');
  const allowedStatuses = ['pending', 'rejected', 'blocked', 'approved', 'all'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  const filter = status === 'all' ? {} : { status };
  const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).lean();
  res.json(requests);
});

router.post('/register-requests/:id/approve', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can approve registration requests' });
  }

  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }

  const existingUser = await User.findOne({ telegramId: request.telegramId }).lean();
  if (existingUser) {
    await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'rejected' });
    return res.status(409).json({ error: 'User already registered' });
  }

  if (!request.role) {
    return res.status(400).json({ error: 'Role is missing in registration request' });
  }

  if (request.role === 'seller' && !request.deliveryGroupId) {
    return res.status(400).json({ error: 'Delivery group is missing for seller' });
  }

  const user = await User.findOneAndUpdate(
    { telegramId: request.telegramId },
    {
      $setOnInsert: {
        telegramId: request.telegramId,
        role: request.role,
        firstName: request.firstName,
        lastName: request.lastName,
        shopName: request.shopName,
        shopCity: request.shopCity,
        deliveryGroupId: request.role === 'seller' ? request.deliveryGroupId || '' : '',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!user) {
    return res.status(409).json({ error: 'User already registered' });
  }
  if (request.role === 'seller' && request.deliveryGroupId) {
    const deliveryGroup = await DeliveryGroup.findByIdAndUpdate(
      request.deliveryGroupId,
      { $addToSet: { members: request.telegramId } },
      { new: true }
    ).lean();
    if (deliveryGroup?.name) {
      await User.findByIdAndUpdate(user._id, { warehouseZone: deliveryGroup.name });
    }
  }
  await RegistrationRequest.findByIdAndDelete(req.params.id);

  await sendRegistrationApprovedMessage(user.telegramId, user.role).catch((err) => {
    console.warn('Failed to send registration approval notification', err?.message || err);
  });

  res.json({ message: 'User approved', telegramId: user.telegramId, role: user.role });
});

router.post('/register-requests/:id/reject', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can reject registration requests' });
  }

  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'rejected' });
  res.json({ message: 'Registration request rejected', telegramId: request.telegramId });
});

router.post('/register-requests/:id/block', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can block registration requests' });
  }

  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'blocked' });
  res.json({ message: 'Registration request blocked', telegramId: request.telegramId });
});

router.post('/register-requests/:id/unblock', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can unblock registration requests' });
  }

  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'blocked') {
    return res.status(404).json({ error: 'Blocked registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'pending' });
  res.json({ message: 'Registration request unblocked', telegramId: request.telegramId });
});

router.delete('/register-requests/:id', async (req, res) => {
  const admin = await ensureAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can delete registration requests' });
  }

  const request = await RegistrationRequest.findByIdAndDelete(req.params.id).lean();
  if (!request) {
    return res.status(404).json({ error: 'Registration request not found' });
  }

  res.json({ message: 'Registration request deleted', telegramId: request.telegramId });
});

module.exports = router;