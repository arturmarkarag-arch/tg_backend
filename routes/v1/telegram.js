const express = require('express');
const { validateTelegramInitData, getInitDataFromRequest, getTelegramId, getTelegramAuth } = require('../../utils/validateTelegramInitData');
const { DAY_SHORT } = require('../../utils/dayNames');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const DeliveryGroup = require('../../models/DeliveryGroup');
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

  const telegramId = parsedData.user?.id || parsedData.id || parsedData.user?.telegram_id;
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
  res.json({
    telegramId: user.telegramId,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    shopName: user.shopName,
    shopNumber: user.shopNumber,
    shopCity: user.shopCity,
    deliveryGroupId: user.deliveryGroupId || '',
    warehouseZone: user.warehouseZone || '',
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

// POST /api/v1/telegram/mini-app/state — зберегти останній переглянутий товар у mini app
router.post('/mini-app/state', async (req, res) => {
  const { initData, currentIndex, currentPage, productId, orderItems, orderItemIds, viewMode, clientOrderId } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

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
router.post('/mini-app/reset-state', async (req, res) => {
  const initData = getInitDataFromRequest(req);
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

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

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState), lastBotState: user.lastBotState || null });
});

// POST /api/v1/telegram/register-request — заявка на реєстрацію нового користувача
router.post('/register-request', async (req, res) => {
  const { initData, firstName, lastName, shopName, deliveryGroupId, role } = req.body;
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

  if (!firstName || !lastName || !role) {
    return res.status(400).json({ error: 'Будь ласка, заповніть всі обов’язкові поля' });
  }
  if (!['seller', 'warehouse'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role selected' });
  }
  if (role === 'seller') {
    if (!shopName) {
      return res.status(400).json({ error: 'Назва магазину є обов’язковою для продавця' });
    }
    if (!deliveryGroupId) {
      return res.status(400).json({ error: 'Група доставки є обов’язковою для продавця' });
    }
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

  let group = null;
  if (role === 'seller') {
    group = await DeliveryGroup.findById(deliveryGroupId).lean();
    if (!group) {
      return res.status(400).json({ error: 'Selected delivery group not found' });
    }
  }

  const request = await RegistrationRequest.create({
    telegramId,
    firstName,
    lastName,
    shopName: role === 'seller' ? shopName : '',
    deliveryGroupId: role === 'seller' ? deliveryGroupId : '',
    role,
    status: 'pending',
    meta: { submittedAt: new Date() },
  });

  const roleLabel = role === 'warehouse' ? 'Склад' : 'Продавець';
  const message = `📥 Нова заявка на реєстрацію (${roleLabel}):\n` +
    `Telegram ID: ${telegramId}\n` +
    `Ім'я: ${firstName}\n` +
    `Прізвище: ${lastName}\n` +
    `Роль: ${roleLabel}\n` +
    `Назва магазину: ${role === 'seller' ? shopName : 'не вказано'}\n` +
    `Група доставки: ${role === 'seller' ? `${group.name} (${DAY_SHORT[group.dayOfWeek] || 'День'})` : 'не вказано'}\n` +
    `Запит створено: ${new Date().toLocaleString()}`;

  sendAdminNotification(message, request._id.toString()).catch(() => {});

  res.status(201).json({ requestId: request._id, status: 'pending' });
});

function getInitData(req) {
  return getInitDataFromRequest(req);
}

async function ensureAdmin(initData) {
  if (!initData) {
    return null;
  }
  const { valid, telegramId } = getTelegramAuth({ body: { initData } }, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid || !telegramId) return null;
  return await User.findOne({ telegramId, role: 'admin' }).lean();
}

router.get('/register-requests', async (req, res) => {
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
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
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
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

  const user = new User({
    telegramId: request.telegramId,
    role: request.role,
    firstName: request.firstName,
    lastName: request.lastName,
    shopName: request.shopName,
    deliveryGroupId: request.role === 'seller' ? request.deliveryGroupId || '' : '',
  });
  await user.save();
  if (request.role === 'seller' && request.deliveryGroupId) {
    await DeliveryGroup.findByIdAndUpdate(
      request.deliveryGroupId,
      { $addToSet: { members: request.telegramId } },
      { new: true }
    );
  }
  await RegistrationRequest.findByIdAndDelete(req.params.id);

  await sendRegistrationApprovedMessage(user.telegramId, user.role).catch((err) => {
    console.warn('Failed to send registration approval notification', err?.message || err);
  });

  res.json({ message: 'User approved', telegramId: user.telegramId, role: user.role });
});

router.post('/register-requests/:id/reject', async (req, res) => {
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
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
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
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
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can unblock registration requests' });
  }

  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'blocked') {
    return res.status(404).json({ error: 'Blocked registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'rejected' });
  res.json({ message: 'Registration request unblocked', telegramId: request.telegramId });
});

router.delete('/register-requests/:id', async (req, res) => {
  const initData = getInitData(req);
  const admin = await ensureAdmin(initData);
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