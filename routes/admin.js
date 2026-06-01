const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const AppSetting = require('../models/AppSetting');
const City = require('../models/City');
const Shop = require('../models/Shop');
const DeliveryGroup   = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const { listOpenAIModels, initOpenAI } = require('../openaiClient');
const { invalidateOrderingScheduleCache, getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { isOrderingOpen, getOpenDateWarsaw } = require('../utils/orderingSchedule');
const { pushSessionEvent } = require('../utils/sessionStatus');
const cache = require('../utils/cache');

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

router.get('/openai/models', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const supportsImage = req.query.supportsImage === 'true';
  const models = await listOpenAIModels({ supportsImage });
  res.json(models);
}));

router.get('/openai/settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const defaultModel = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
  const selectedModel = await getAppSetting(OPENAI_MODEL_SETTING_KEY, defaultModel);
  res.json({ model: selectedModel });
}));

router.post('/openai/settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const model = req.body?.model;
  if (!model || typeof model !== 'string') throw appError('openai_model_required');

  const models = await listOpenAIModels();
  if (!models.some((item) => item.id === model)) throw appError('openai_model_unknown');

  const selectedModel = await setAppSetting(OPENAI_MODEL_SETTING_KEY, model);
  res.json({ model: selectedModel });
}));

// ── Vision (photo search) settings ────────────────────────────────────────────
const VISION_THRESHOLD_KEY = 'vision.threshold';
const VISION_THRESHOLD_DEFAULT = 0.6;

router.get('/vision-settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const threshold = await getAppSetting(VISION_THRESHOLD_KEY, VISION_THRESHOLD_DEFAULT);
  res.json({ threshold: Number(threshold) });
}));

router.post('/vision-settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const t = parseFloat(req.body?.threshold);
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    return res.status(400).json({ error: 'invalid_threshold', message: 'Поріг має бути від 0 до 1' });
  }
  const threshold = await setAppSetting(VISION_THRESHOLD_KEY, t);
  res.json({ threshold: Number(threshold) });
}));

router.get('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const saved = await getAppSetting(ORDERING_SCHEDULE_KEY, ORDERING_SCHEDULE_DEFAULTS);
  res.json({ ...ORDERING_SCHEDULE_DEFAULTS, ...saved });
}));

router.post('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { openHour, openMinute, closeHour, closeMinute } = req.body;
  const toInt = (v, min, max) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < min || n > max) {
      throw appError('schedule_invalid', { reason: `Значення ${v} поза діапазоном [${min}, ${max}]` });
    }
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
  if (openMins === closeMins) throw appError('schedule_zero_duration');

  // Snapshot the previous schedule BEFORE saving so the "Змінені години" event
  // payload carries the actual transition. Read via the same setter helper.
  const previous = await getAppSetting(ORDERING_SCHEDULE_KEY, ORDERING_SCHEDULE_DEFAULTS);

  const saved = await setAppSetting(ORDERING_SCHEDULE_KEY, schedule);
  await invalidateOrderingScheduleCache();

  // Tell every group whose ordering window is OPEN right now that hours moved.
  // Sellers in those groups are mid-decision; warehouse needs the audit trail.
  // Best-effort, off the response path — a slow Mongo here must not delay the
  // settings response or surface as a 500.
  const admin = req.telegramUser || {};
  const adminActor = {
    by: String(admin.telegramId || ''),
    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
  };
  (async () => {
    try {
      const groups = await DeliveryGroup.find({}, 'dayOfWeek').lean();
      const freshSchedule = await getOrderingSchedule();
      const targetGroups = groups.filter((g) => isOrderingOpen(g.dayOfWeek, freshSchedule).isOpen);
      for (const g of targetGroups) {
        // Only push the event to an EXISTING session — never auto-create one
        // here. A brand-new group with no orders this cycle shouldn't get a
        // spurious empty session doc just to host an "Змінені години" entry.
        const openDate = getOpenDateWarsaw(g.dayOfWeek, freshSchedule);
        const existing = await OrderingSession.findOne(
          { groupId: String(g._id), openDate },
          '_id',
        ).lean();
        if (!existing) continue;
        await pushSessionEvent(String(existing._id), {
          type: 'hours_changed',
          ...adminActor,
          meta: { from: previous, to: schedule },
        });
      }
    } catch (e) {
      console.warn('[admin/ordering-schedule] hours_changed event push failed:', e.message);
    }
  })();

  res.json(saved);
}));

// GET /api/admin/cities — список міст з City колекції
router.get('/cities', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const cities = await City.find().sort({ name: 1 }).lean();
  res.json(cities); // [{_id, name, country}]
}));

// POST /api/admin/cities — створити нове місто
router.post('/cities', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw appError('city_name_required');
  try {
    const city = await City.create({ name, country: req.body?.country || 'PL' });
    await cache.invalidate(cache.KEYS.CITIES);
    res.status(201).json(city);
  } catch (err) {
    if (err.code === 11000) throw appError('city_already_exists', { name });
    throw err;
  }
}));

// PATCH /api/admin/cities/:id — перейменувати місто
router.patch('/cities/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw appError('city_name_required');
  try {
    const city = await City.findByIdAndUpdate(
      req.params.id,
      { name },
      { new: true, runValidators: true }
    );
    if (!city) throw appError('city_not_found');
    await cache.invalidate(cache.KEYS.CITIES);
    res.json(city);
  } catch (err) {
    if (err && err.name === 'AppError') throw err;
    if (err.code === 11000) throw appError('city_already_exists', { name });
    throw err;
  }
}));

// DELETE /api/admin/cities/:id — видалити місто (якщо немає магазинів)
router.delete('/cities/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Транзакція захищає від race-condition: між countDocuments і findByIdAndDelete
  // адмін міг створити новий магазин, який стане «висіти» на видаленому місті.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const shopCount = await Shop.countDocuments({ cityId: req.params.id }).session(session);
      if (shopCount > 0) throw appError('city_has_shops', { shopCount });
      const deleted = await City.findByIdAndDelete(req.params.id, { session });
      if (!deleted) throw appError('city_not_found');
      await cache.invalidate(cache.KEYS.CITIES);
      result = { message: 'Місто видалено' };
    });
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

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

// ── Price groups (Telegram «Група ціна на товар») ─────────────────────────────
// Separate list from TELEGRAM_GROUPS_KEY: groups that receive «Яка ціна?» photo
// requests from the photo-search page. No env fallback — DB only.
const PRICE_GROUPS_KEY = 'telegram.priceGroupIds';

async function getPriceGroupIds() {
  const fromDb = await getAppSetting(PRICE_GROUPS_KEY, null);
  return Array.isArray(fromDb) ? fromDb.map(String) : [];
}

router.get('/price-groups', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    res.json({ groups: await getPriceGroupIds() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/price-groups', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const groupId = String(req.body?.groupId || '').trim();
    if (!groupId || !/^-?\d+$/.test(groupId)) {
      return res.status(400).json({ error: 'groupId має бути числом' });
    }
    const current = await getPriceGroupIds();
    if (current.includes(groupId)) {
      return res.status(409).json({ error: 'Ця група вже додана' });
    }
    const updated = [...current, groupId];
    await setAppSetting(PRICE_GROUPS_KEY, updated);
    res.json({ groups: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/price-groups/:groupId', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  try {
    const groupId = String(req.params.groupId).trim();
    const current = await getPriceGroupIds();
    const updated = current.filter((id) => id !== groupId);
    await setAppSetting(PRICE_GROUPS_KEY, updated);
    res.json({ groups: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Group members ─────────────────────────────────────────────────────────────

router.get('/telegram-groups/:groupId/members', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { getMembersWithStatus } = require('../services/groupMemberSync');
  const groupId = String(req.params.groupId).trim();
  const allowedIds = await getAllowedGroupIds();
  if (!allowedIds.includes(groupId)) return res.status(403).json({ error: 'Група не авторизована' });

  const members = await getMembersWithStatus(groupId);
  res.json(members);
}));

// Re-check a single unregistered member's live group status and, if they are
// still in the group (and still not registered), re-push the registration
// prompt. If they actually left, mark them so the list drops them.
router.post('/telegram-groups/:groupId/members/:telegramId/recheck', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { recheckAndRepushWelcome } = require('../telegramBot');
  const groupId = String(req.params.groupId).trim();
  const telegramId = String(req.params.telegramId).trim();
  const allowedIds = await getAllowedGroupIds();
  if (!allowedIds.includes(groupId)) return res.status(403).json({ error: 'Група не авторизована' });

  const result = await recheckAndRepushWelcome(groupId, telegramId);
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
}));

router.get('/group-members/unregistered-count', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { getMembersWithStatus } = require('../services/groupMemberSync');
  const groupIds = await getAllowedGroupIds();
  const results = await Promise.all(groupIds.map((id) => getMembersWithStatus(id)));
  const count = results.flat().filter((r) => !r.isRegistered).length;
  res.json({ count });
}));

// ── OpenAI Costs & Usage (Admin Key required) ─────────────────────────────────

async function fetchOpenAIAdmin(path) {
  const key = process.env.ADMIN_OPENAPI;
  if (!key) throw new Error('ADMIN_OPENAPI не встановлено в .env');
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `OpenAI Admin API ${res.status}`);
  return json;
}

router.get('/openai/costs', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  if (!process.env.ADMIN_OPENAPI) {
    return res.status(503).json({ error: 'admin_key_missing', message: 'ADMIN_OPENAPI не встановлено в .env' });
  }
  const days      = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const endTime   = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const data = await fetchOpenAIAdmin(
    `/organization/costs?start_time=${startTime}&end_time=${endTime}&limit=${days}&bucket_width=1d&group_by=line_item`,
  );
  res.json(data);
}));

router.get('/openai/usage', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  if (!process.env.ADMIN_OPENAPI) {
    return res.status(503).json({ error: 'admin_key_missing', message: 'ADMIN_OPENAPI не встановлено в .env' });
  }
  const days      = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const endTime   = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const data = await fetchOpenAIAdmin(
    `/organization/usage/completions?start_time=${startTime}&end_time=${endTime}&limit=${days}&bucket_width=1d&group_by=model`,
  );
  res.json(data);
}));

router.getAllowedGroupIds = getAllowedGroupIds;
router.getPriceGroupIds = getPriceGroupIds;
module.exports = router;
