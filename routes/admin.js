const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const AppSetting = require('../models/AppSetting');
const City = require('../models/City');
const Shop = require('../models/Shop');
const DeliveryGroup   = require('../models/DeliveryGroup');
const { listOpenAIModels, initOpenAI } = require('../openaiClient');
const cache = require('../utils/cache');
const { softRemoveUser } = require('../services/softRemoveUser');
const { getIO } = require('../socket');
const {
  MAX_SUPPORT_ADMINS,
  normalizeSupportAdmin,
  getSupportAdmins,
  saveSupportAdmins,
  toPublicSupportAdmins,
} = require('../utils/telegramSupportAdmins');

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


// ── Telegram delivery ledger ─────────────────────────────────────────────────
// Durable per-recipient truth for system broadcasts. `sent` means Telegram
// returned a Message (message_id/date); it is NOT a read/device receipt.
router.get('/telegram-delivery/events', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { listEvents } = require('../services/telegramDeliveryLedger');
  const events = await listEvents({
    deliveryGroupId: String(req.query.deliveryGroupId || ''),
    kind: String(req.query.kind || ''),
    limit: req.query.limit,
  });
  res.json(events);
}));

router.get('/telegram-delivery/events/:eventKey', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { getEventWithDeliveries } = require('../services/telegramDeliveryLedger');
  const snapshot = await getEventWithDeliveries(req.params.eventKey);
  if (!snapshot) return res.status(404).json({ error: 'telegram_delivery_event_not_found', message: 'Журнал розсилки не знайдено' });

  const privateIds = snapshot.deliveries
    .filter((row) => row.channel === 'private')
    .map((row) => String(row.recipientId));
  const [users, orders] = await Promise.all([
    privateIds.length
      ? require('../models/User').find({ telegramId: { $in: privateIds } }, 'telegramId firstName lastName lastAppOpenedAt botBlocked shopId').lean()
      : [],
    snapshot.event.sourceType === 'ordering_session' && privateIds.length
      ? require('../models/Order').find(
          { orderingSessionId: String(snapshot.event.sourceId), buyerTelegramId: { $in: privateIds } },
          'buyerTelegramId orderNumber status createdAt',
        ).lean()
      : [],
  ]);
  const userById = new Map(users.map((u) => [String(u.telegramId), u]));
  const orderById = new Map();
  for (const order of orders) {
    const key = String(order.buyerTelegramId || '');
    if (!orderById.has(key)) orderById.set(key, []);
    orderById.get(key).push(order);
  }

  res.json({
    event: snapshot.event,
    deliveries: snapshot.deliveries.map((row) => {
      if (row.channel !== 'private') return row;
      const user = userById.get(String(row.recipientId));
      const deliveredAt = row.telegramDate || row.sentAt || null;
      const lastAppOpenedAt = user?.lastAppOpenedAt || null;
      const appOpenedAfterSend = Boolean(deliveredAt && lastAppOpenedAt && new Date(lastAppOpenedAt) >= new Date(deliveredAt));
      return {
        ...row,
        recipientName: row.recipientName || [user?.firstName, user?.lastName].filter(Boolean).join(' '),
        botBlockedNow: Boolean(user?.botBlocked),
        lastAppOpenedAt,
        appOpenedAfterSend,
        orderedInSourceSession: (orderById.get(String(row.recipientId)) || []).length > 0,
        ordersInSourceSession: orderById.get(String(row.recipientId)) || [],
      };
    }),
  });
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

// Legacy global schedule API. Runtime session logic no longer reads this key;
// it is kept read-only only so an older admin client can display the old value
// during a rolling deployment. New schedules are edited per DeliveryGroup.
router.get('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const saved = await getAppSetting(ORDERING_SCHEDULE_KEY, ORDERING_SCHEDULE_DEFAULTS);
  res.json({ ...ORDERING_SCHEDULE_DEFAULTS, ...saved, deprecated: true });
}));

router.post('/ordering-schedule', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  return res.status(410).json({
    error: 'ordering_schedule_global_disabled',
    message: 'Глобальний розклад вимкнено. Налаштовуйте час окремо в кожній групі доставки.',
  });
}));

// ── Дозамовлення ─────────────────────────────────────────────────────────────
// Пряме посилання на Mini App для Telegram-сповіщень. Без fallback на env або
// username бота: зміна посилання виконується тільки через це налаштування.
const {
  getSupplementSettings,
  invalidateSupplementSettingsCache,
  normalizeSupplementSettings,
  isValidSupplementAppUrl,
  SUPPLEMENT_SETTINGS_KEY,
} = require('../utils/supplementSettings');

router.get('/supplement-settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  res.json(await getSupplementSettings());
}));

router.post('/supplement-settings', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const appUrl = String(req.body?.appUrl || '').trim();
  if (!isValidSupplementAppUrl(appUrl)) {
    throw appError('supplement_app_url_invalid');
  }
  const value = normalizeSupplementSettings({ appUrl });
  await setAppSetting(SUPPLEMENT_SETTINGS_KEY, value);
  await invalidateSupplementSettingsCache();
  res.json(value);
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

// ── Telegram contacts shown to unregistered users ────────────────────────────
router.get('/telegram-support-admins', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  res.json({ admins: toPublicSupportAdmins(await getSupportAdmins()) });
}));

router.post('/telegram-support-admins', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const admin = normalizeSupportAdmin(req.body);
  if (!admin) {
    return res.status(400).json({
      error: 'telegram_support_admin_invalid',
      message: 'Вкажіть ім\'я та коректний Telegram username (наприклад @username).',
    });
  }

  const current = await getSupportAdmins();
  if (current.some((item) => item.username.toLowerCase() === admin.username.toLowerCase())) {
    return res.status(409).json({
      error: 'telegram_support_admin_exists',
      message: 'Цей Telegram адміністратор уже доданий.',
    });
  }
  if (current.length >= MAX_SUPPORT_ADMINS) {
    return res.status(409).json({
      error: 'telegram_support_admin_limit',
      message: `Можна додати максимум ${MAX_SUPPORT_ADMINS} контактів.`,
    });
  }

  const admins = await saveSupportAdmins([...current, admin]);
  res.json({ admins: toPublicSupportAdmins(admins) });
}));

router.delete('/telegram-support-admins/:username', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const username = String(req.params.username || '').replace(/^@+/, '').trim().toLowerCase();
  const current = await getSupportAdmins();
  const admins = await saveSupportAdmins(current.filter((item) => item.username.toLowerCase() !== username));
  res.json({ admins: toPublicSupportAdmins(admins) });
}));

// ── Telegram «Нові Товари» ────────────────────────────────────────────────
// One dedicated destination, DB-only. It is intentionally independent from the
// bot-authorized groups and «Група ціна на товар» lists.
router.get('/telegram-new-products-group', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { getNewProductsGroupId, inspectNewProductsGroup } = require('../services/receiptNewProductTelegram');
  const { getTelegramMessageCleanupHealth } = require('../services/telegramMessageCleanup');
  const groupId = await getNewProductsGroupId();
  const [health, cleanup] = await Promise.all([
    inspectNewProductsGroup(groupId),
    getTelegramMessageCleanupHealth(),
  ]);
  res.json({ groupId, health, cleanup });
}));

router.post('/telegram-new-products-group', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { setNewProductsGroupId } = require('../services/receiptNewProductTelegram');
  try {
    const result = await setNewProductsGroupId(req.body?.groupId, { actorId: String(req.telegramUser?.telegramId || '') });
    res.json(result);
  } catch (err) {
    if (err?.message === 'telegram_new_products_group_invalid') throw appError('telegram_new_products_group_invalid');
    if (err?.message === 'telegram_new_products_group_unavailable') {
      throw appError('telegram_new_products_group_unavailable', { health: err.health });
    }
    throw err;
  }
}));

router.post('/telegram-new-products-cleanups/:cleanupId/resolve', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { resolveTelegramMessageCleanup } = require('../services/telegramMessageCleanup');
  if (!mongoose.Types.ObjectId.isValid(String(req.params.cleanupId || ''))) throw appError('validation_failed', { field: 'cleanupId' });
  const row = await resolveTelegramMessageCleanup(req.params.cleanupId, {
    actorId: String(req.telegramUser?.telegramId || ''),
    note: String(req.body?.note || ''),
  });
  if (!row) throw appError('telegram_cleanup_not_found');
  res.json(row);
}));

router.post('/telegram-new-products-cleanups/:cleanupId/retry', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { retryTelegramMessageCleanup } = require('../services/telegramMessageCleanup');
  if (!mongoose.Types.ObjectId.isValid(String(req.params.cleanupId || ''))) throw appError('validation_failed', { field: 'cleanupId' });
  const row = await retryTelegramMessageCleanup(req.params.cleanupId, { actorId: String(req.telegramUser?.telegramId || '') });
  if (!row) throw appError('telegram_cleanup_not_retryable');
  res.json(row);
}));

router.post('/telegram-new-products-bindings/:bindingId/resolve-absent', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { resolveAmbiguousTelegramBinding } = require('../services/telegramMessageCleanup');
  if (!mongoose.Types.ObjectId.isValid(String(req.params.bindingId || ''))) throw appError('validation_failed', { field: 'bindingId' });
  const row = await resolveAmbiguousTelegramBinding(req.params.bindingId, {
    actorId: String(req.telegramUser?.telegramId || ''),
    note: String(req.body?.note || 'Перевірено адміністратором: посту немає'),
  });
  if (!row) throw appError('telegram_new_products_unknown_binding_not_found');
  res.json(row);
}));

router.post('/telegram-new-products-bindings/:bindingId/identify', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { identifyAmbiguousTelegramBinding } = require('../services/telegramMessageCleanup');
  if (!mongoose.Types.ObjectId.isValid(String(req.params.bindingId || ''))) throw appError('validation_failed', { field: 'bindingId' });
  try {
    const result = await identifyAmbiguousTelegramBinding(req.params.bindingId, {
      actorId: String(req.telegramUser?.telegramId || ''),
      chatId: String(req.body?.chatId || ''),
      messageId: req.body?.messageId,
    });
    if (!result) throw appError('telegram_new_products_unknown_binding_not_found');
    res.json(result);
  } catch (error) {
    if (error?.message === 'telegram_new_products_message_reference_invalid') throw appError('telegram_new_products_message_reference_invalid');
    if (error?.code === 'EBOTUNAVAILABLE') throw appError('telegram_bot_unavailable');
    throw error;
  }
}));

router.get('/telegram-new-products-history', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const TelegramPublicationEvent = require('../models/TelegramPublicationEvent');
  const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
  const events = await TelegramPublicationEvent.find({ destinationKey: 'new_products' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ events });
}));

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

// UI label: "Видалити". This is a SOFT account removal, not Mongo deletion.
// The User row and GroupMember history stay in the database, but access closes
// immediately and the identity disappears from live lists. A later legitimate
// registration can reactivate the same User row after all normal gates pass.
router.delete('/telegram-groups/:groupId/members/:telegramId', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const groupId = String(req.params.groupId).trim();
  const telegramId = String(req.params.telegramId).trim();
  const allowedIds = await getAllowedGroupIds();
  if (!allowedIds.includes(groupId)) return res.status(403).json({ error: 'Група не авторизована' });
  if (!/^\d+$/.test(telegramId)) return res.status(400).json({ error: 'Некоректний Telegram ID' });

  const result = await softRemoveUser({
    telegramId,
    actor: req.telegramUser,
    groupChatId: groupId,
  });

  // Kill any already-open HTTP-independent session immediately. Subsequent HTTP
  // calls are denied by accountState=removed; browser JWTs were revoked too.
  try {
    const io = getIO();
    io?.to(`user_${telegramId}`).emit('account_removed', { telegramId });
    io?.in(`user_${telegramId}`).disconnectSockets(true);
  } catch (_) { /* best-effort */ }

  res.json({
    ...result,
    removed: true,
    hidden: true,
    groupId,
    telegramId,
    canRegisterAgain: true,
  });
}));

// Live-check one person. IMPORTANT: this is a notification-free admin audit.
// It only reads getChatMember and updates technical status fields in GroupMember.
// No welcome / registration / push message is sent or deleted.
router.post('/telegram-groups/:groupId/members/:telegramId/recheck', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { checkAndPersistGroupMember } = require('../services/groupMemberAudit');
  const groupId = String(req.params.groupId).trim();
  const telegramId = String(req.params.telegramId).trim();
  const allowedIds = await getAllowedGroupIds();
  if (!allowedIds.includes(groupId)) return res.status(403).json({ error: 'Група не авторизована' });

  const result = await checkAndPersistGroupMember(groupId, telegramId);
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
}));

// Bulk live-check for the selected group. Includes everyone the bot has ever
// observed in that group + all registered sellers, which surfaces the reverse
// discrepancy "є в додатку, але немає в Telegram-групі". Sequential by design
// to stay below Telegram rate limits. Never sends notifications.
router.post('/telegram-groups/:groupId/check-all', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { auditGroup } = require('../services/groupMemberAudit');
  const groupId = String(req.params.groupId).trim();
  const allowedIds = await getAllowedGroupIds();
  if (!allowedIds.includes(groupId)) return res.status(403).json({ error: 'Група не авторизована' });

  const result = await auditGroup(groupId);
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
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
