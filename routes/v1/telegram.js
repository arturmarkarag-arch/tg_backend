const express = require('express');
const { validateTelegramInitData } = require('../../utils/validateTelegramInitData');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const { sendAdminNotification } = require('../../telegramBot');

const router = express.Router();

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
  const { initData } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  // 1. Валідуємо підпис Telegram
  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  const telegramId = String(parsedData.user?.id || parsedData.id || '');
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  // 2. Шукаємо в нашій базі
  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
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
    miniAppState: user.miniAppState || {
      lastViewedProductId: '',
      currentIndex: 0,
      updatedAt: null,
    },
  });
});

// POST /api/v1/telegram/mini-app/state — зберегти останній переглянутий товар у mini app
router.post('/mini-app/state', async (req, res) => {
  const { initData, currentIndex, productId, orderItems } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  const telegramId = String(parsedData.user?.id || parsedData.id || '');
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    return res.status(400).json({ error: 'currentIndex must be a non-negative integer' });
  }

  const sanitizedOrderItems = typeof orderItems === 'object' && orderItems !== null
    ? Object.fromEntries(Object.entries(orderItems).map(([productId, qty]) => [String(productId), Number(qty) || 0]))
    : {};

  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        'miniAppState.currentIndex': currentIndex,
        'miniAppState.lastViewedProductId': String(productId || ''),
        'miniAppState.orderItems': sanitizedOrderItems,
        'miniAppState.updatedAt': new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!user) {
    return res.status(403).json({ error: 'User not found' });
  }

  res.json({ miniAppState: user.miniAppState });
});

// POST /api/v1/telegram/register-request — заявка на реєстрацію нового продавця
router.post('/register-request', async (req, res) => {
  const { initData, firstName, lastName, phoneNumber, shopCity, shopAddress, shopName, deliveryGroupId } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'initData is required' });
  }

  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  const telegramId = String(parsedData.user?.id || parsedData.id || '');
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  if (!firstName || !lastName || !phoneNumber || !shopCity || !shopAddress || !shopName || !deliveryGroupId) {
    return res.status(400).json({ error: 'All registration fields are required' });
  }

  const existingUser = await User.findOne({ telegramId }).lean();
  if (existingUser) {
    return res.status(409).json({ error: 'User already registered' });
  }

  const existingRequest = await RegistrationRequest.findOne({ telegramId }).lean();
  if (existingRequest) {
    return res.status(409).json({ error: 'Registration request already exists' });
  }

  const group = await DeliveryGroup.findById(deliveryGroupId).lean();
  if (!group) {
    return res.status(400).json({ error: 'Selected delivery group not found' });
  }

  const request = await RegistrationRequest.create({
    telegramId,
    firstName,
    lastName,
    phoneNumber,
    shopCity,
    shopAddress,
    shopName,
    deliveryGroupId,
    status: 'pending',
    meta: { submittedAt: new Date() },
  });

  const message = `📥 Нова заявка на реєстрацію продавця:\n` +
    `Telegram ID: ${telegramId}\n` +
    `Ім'я: ${firstName}\n` +
    `Прізвище: ${lastName}\n` +
    `Телефон: ${phoneNumber}\n` +
    `Місто: ${shopCity}\n` +
    `Назва магазину: ${shopName}\n` +
    `Адреса: ${shopAddress}\n` +
    `Група доставки: ${group.name} (${['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][group.dayOfWeek] || 'День'})\n` +
    `Запит створено: ${new Date().toLocaleString()}`;

  sendAdminNotification(message).catch(() => {});

  res.status(201).json({ requestId: request._id, status: 'pending' });
});

async function ensureAdmin(initData) {
  if (!initData) {
    return null;
  }
  const { valid, parsedData } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) return null;
  const telegramId = String(parsedData.user?.id || parsedData.id || '');
  if (!telegramId) return null;
  return await User.findOne({ telegramId, role: 'admin' }).lean();
}

router.get('/register-requests', async (req, res) => {
  const initData = req.body?.initData || req.query?.initData;
  const admin = await ensureAdmin(initData);
  if (!admin) {
    return res.status(403).json({ error: 'Only admin can access registration requests' });
  }

  const requests = await RegistrationRequest.find({ status: 'pending' }).sort({ createdAt: -1 }).lean();
  res.json(requests);
});

router.post('/register-requests/:id/approve', async (req, res) => {
  const { initData } = req.body;
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

  const user = new User({
    telegramId: request.telegramId,
    role: 'seller',
    firstName: request.firstName,
    lastName: request.lastName,
    phoneNumber: request.phoneNumber,
    shopCity: request.shopCity,
    shopAddress: request.shopAddress,
    shopName: request.shopName,
    deliveryGroupId: request.deliveryGroupId || '',
  });
  await user.save();
  if (request.deliveryGroupId) {
    await DeliveryGroup.findByIdAndUpdate(
      request.deliveryGroupId,
      { $addToSet: { members: request.telegramId } },
      { new: true }
    );
  }
  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'approved' });

  res.json({ message: 'User approved', telegramId: user.telegramId, role: user.role });
});

module.exports = router;