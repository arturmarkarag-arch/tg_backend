const express = require('express');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const AppSetting = require('../models/AppSetting');
const City = require('../models/City');
const Shop = require('../models/Shop');
const { listOpenAIModels, initOpenAI } = require('../openaiClient');

const router = express.Router();
const OPENAI_MODEL_SETTING_KEY = 'openai.defaultModel';
const ORDERING_SCHEDULE_KEY = 'ordering.schedule';
const ORDERING_SCHEDULE_DEFAULTS = { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };

async function getAppSetting(key, defaultValue = null) {
  const setting = await AppSetting.findOne({ key }).lean();
  return setting?.value ?? defaultValue;
}

async function setAppSetting(key, value) {
  const setting = await AppSetting.findOneAndUpdate(
    { key },
    { value },
    { upsert: true, new: true }
  ).lean();
  return setting.value;
}

router.get('/openai/models', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const supportsImage = req.query.supportsImage === 'true';
    const models = await listOpenAIModels({ supportsImage });
    res.json(models);
  } catch (error) {
    console.error('[admin/openai/models] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to fetch OpenAI models' });
  }
});

router.get('/openai/settings', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const defaultModel = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
    const selectedModel = await getAppSetting(OPENAI_MODEL_SETTING_KEY, defaultModel);
    res.json({ model: selectedModel });
  } catch (error) {
    console.error('[admin/openai/settings] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to read OpenAI settings' });
  }
});

router.post('/openai/settings', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const model = req.body?.model;
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'Model is required' });
    }

    const models = await listOpenAIModels();
    if (!models.some((item) => item.id === model)) {
      return res.status(400).json({ error: 'Unknown or unsupported model' });
    }

    const selectedModel = await setAppSetting(OPENAI_MODEL_SETTING_KEY, model);
    res.json({ model: selectedModel });
  } catch (error) {
    console.error('[admin/openai/settings] error', error.message || error);
    res.status(500).json({ error: error.message || 'Unable to save OpenAI settings' });
  }
});

router.get('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const saved = await getAppSetting(ORDERING_SCHEDULE_KEY, ORDERING_SCHEDULE_DEFAULTS);
    res.json({ ...ORDERING_SCHEDULE_DEFAULTS, ...saved });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to read ordering schedule' });
  }
});

router.post('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const { openHour, openMinute, closeHour, closeMinute } = req.body;
    const toInt = (v, min, max) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < min || n > max) throw new Error(`Value ${v} out of range [${min}, ${max}]`);
      return n;
    };
    const schedule = {
      openHour:    toInt(openHour,    0, 23),
      openMinute:  toInt(openMinute,  0, 59),
      closeHour:   toInt(closeHour,   0, 23),
      closeMinute: toInt(closeMinute, 0, 59),
    };
    // Заборонити нульове вікно: open і close однакові немає сенсу.
    // open < close — звичайне вікно (16:00→07:30 наступного дня).
    // open > close — вікно з переходом через північ (теж коректно, бо open/close завжди різні календарні дні).
    const openMins  = schedule.openHour  * 60 + schedule.openMinute;
    const closeMins = schedule.closeHour * 60 + schedule.closeMinute;
    if (openMins === closeMins) {
      return res.status(400).json({ error: 'Open time and close time cannot be identical — window would have zero duration' });
    }
    const saved = await setAppSetting(ORDERING_SCHEDULE_KEY, schedule);

    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid schedule data' });
  }
});

// GET /api/admin/cities — список міст з City колекції
router.get('/cities', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const cities = await City.find().sort({ name: 1 }).lean();
    res.json(cities); // [{_id, name, country}]
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cities — створити нове місто
router.post('/cities', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name є обовʼязковим' });
    const city = await City.create({ name, country: req.body?.country || 'PL' });
    res.status(201).json(city);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: `Місто "${req.body?.name}" вже існує` });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/cities/:id — перейменувати місто
router.patch('/cities/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name є обовʼязковим' });
    const city = await City.findByIdAndUpdate(
      req.params.id,
      { name },
      { new: true, runValidators: true }
    );
    if (!city) return res.status(404).json({ error: 'Місто не знайдено' });
    res.json(city);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: `Місто з такою назвою вже існує` });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/cities/:id — видалити місто (якщо немає магазинів)
router.delete('/cities/:id', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const shopCount = await Shop.countDocuments({ cityId: req.params.id });
    if (shopCount > 0) {
      return res.status(400).json({ error: `Не можна видалити: ${shopCount} магазин(ів) прив'язано до цього міста` });
    }
    await City.findByIdAndDelete(req.params.id);
    res.json({ message: 'Місто видалено' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Telegram allowed groups ──────────────────────────────────────────────────
const TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds';

async function getAllowedGroupIds() {
  const fromDb = await getAppSetting(TELEGRAM_GROUPS_KEY, null);
  if (Array.isArray(fromDb) && fromDb.length > 0) return fromDb.map(String);
  // fallback to env
  return (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}
// ── OpenAI API Key ──────────────────────────────────────────────────────────
const OPENAI_API_KEY_SETTING = 'openai.apiKey';

function maskApiKey(key) {
  if (!key) return '';
  const n = key.length;
  if (n <= 8) return '*'.repeat(n);
  const q = Math.floor(n / 4);
  const vis = Math.min(13, Math.max(6, Math.floor(q * 0.45)));
  const off = Math.floor(q * 0.1);
  return (
    '******' +
    key.slice(off, off + vis) +
    '*'.repeat(5) +
    key.slice(q + off, q + off + vis) +
    '*****' +
    key.slice(2 * q + off, 2 * q + off + vis) +
    '****' +
    key.slice(3 * q + off, 3 * q + off + vis) +
    '****'
  );
}

router.get('/openai-key', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const fromDb = await getAppSetting(OPENAI_API_KEY_SETTING, null);
    const key = fromDb || process.env.OPENAI_API_KEY || '';
    res.json({
      masked: maskApiKey(key),
      isSet: Boolean(key),
      source: fromDb ? 'db' : (process.env.OPENAI_API_KEY ? 'env' : 'none'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/openai-key', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'apiKey не може бути порожнім' });
    if (!apiKey.startsWith('sk-')) return res.status(400).json({ error: 'Невалідний ключ OpenAI (має починатись з sk-)' });
    await setAppSetting(OPENAI_API_KEY_SETTING, apiKey);
    initOpenAI(apiKey); // reinitialize live client
    res.json({ masked: maskApiKey(apiKey), isSet: true, source: 'db' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/telegram-groups', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const ids = await getAllowedGroupIds();
    res.json({ groups: ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/telegram-groups', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const groupId = String(req.body?.groupId || '').trim();
    if (!groupId || !/^-?\d+$/.test(groupId)) {
      return res.status(400).json({ error: 'groupId має бути числом' });
    }
    const current = await getAllowedGroupIds();
    if (current.includes(groupId)) {
      return res.status(409).json({ error: 'Ця група вже додана' });
    }
    const updated = [...current, groupId];
    await setAppSetting(TELEGRAM_GROUPS_KEY, updated);
    res.json({ groups: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/telegram-groups/:groupId', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const groupId = String(req.params.groupId).trim();
    const current = await getAllowedGroupIds();
    const updated = current.filter((id) => id !== groupId);
    await setAppSetting(TELEGRAM_GROUPS_KEY, updated);
    res.json({ groups: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.getAllowedGroupIds = getAllowedGroupIds;
module.exports = router;
