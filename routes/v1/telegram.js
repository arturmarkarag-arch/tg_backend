const express = require('express');
const { validateTelegramInitData } = require('../../utils/validateTelegramInitData');
const User = require('../../models/User');

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
  });
});

module.exports = router;