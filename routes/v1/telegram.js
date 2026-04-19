const express = require('express');
const { validateTelegramInitData } = require('../../utils/validateTelegramInitData');

const router = express.Router();

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

module.exports = router;
