const express = require('express');
const { validateTelegramInitData, getInitDataFromRequest, getTelegramId, getTelegramAuth } = require('../../utils/validateTelegramInitData');
const { requireTelegramRole } = require('../../middleware/telegramAuth');
const { DAY_SHORT } = require('../../utils/dayNames');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const DeliveryGroup = require('../../models/DeliveryGroup');
const Shop = require('../../models/Shop');
const { sendAdminNotification, sendRegistrationApprovedMessage } = require('../../telegramBot');
const { getOrderingWindowOpenAt, getCurrentOrderingSessionId } = require('../../utils/orderingSchedule');
const { getOrderingSchedule } = require('../../utils/getOrderingSchedule');
const Order = require('../../models/Order');
const { getIO } = require('../../socket');

const router = express.Router();
const adminOnly = requireTelegramRole('admin');

function normalizeMiniAppState(miniAppState) {
  if (!miniAppState || typeof miniAppState !== 'object') return miniAppState;
  return { ...miniAppState };
}

function normalizeCartState(cartState) {
  const defaults = { orderItems: {}, orderItemIds: [], lastOrderPositions: 0, lastViewedProductId: '', currentIndex: 0, currentPage: 0, updatedAt: null, lastModifiedByTelegramId: null, lastModifiedByName: null, activeSellerCount: 1, reservedForGroupId: null };
  if (!cartState || typeof cartState !== 'object') return defaults;
  const result = { ...defaults, ...cartState };
  if (result.orderItems instanceof Map) {
    result.orderItems = Object.fromEntries(result.orderItems);
  } else if (result.orderItems && typeof result.orderItems === 'object' && !Array.isArray(result.orderItems)) {
    result.orderItems = Object.fromEntries(Object.entries(result.orderItems));
  } else {
    result.orderItems = {};
  }
  return result;
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
  const initData = getInitDataFromRequest(req);
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

    const rejectedRequest = await RegistrationRequest.findOne({ telegramId, status: 'rejected' }).lean();
    if (rejectedRequest) {
      return res.status(403).json({
        error: 'rejected_registration',
        telegramId,
        message: 'Вашу заявку було відхилено. Ви можете надіслати нову заявку.',
      });
    }

    return res.status(403).json({
      error: 'not_registered',
      telegramId,
      message: 'Вас не знайдено в системі. Зверніться до адміністратора.',
    });
  }

  // 3. Повертаємо профіль (без чутливих полів)
  const userShop = user.shopId ? await Shop.findById(user.shopId).populate('cityId', 'name').lean() : null;
  const resolvedGroupId = userShop?.deliveryGroupId || user.deliveryGroupId || '';

  // Обчислити sessionOpenAt для продавця та адміна з магазином (для визначення нової сесії на клієнті)
  let sessionOpenAt = null;
  if ((user.role === 'seller' || user.role === 'admin') && resolvedGroupId) {
    try {
      const group = await DeliveryGroup.findById(resolvedGroupId).lean();
      if (group) {
        const schedule = await getOrderingSchedule();
        sessionOpenAt = getOrderingWindowOpenAt(group.dayOfWeek, schedule).toISOString();
      }
    } catch { /* non-critical */ }
  }

  // Count sellers from the same shop active in the last 30 minutes (co-seller awareness)
  let activeSellerCount = 1;
  if (userShop) {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    activeSellerCount = await User.countDocuments({
      shopId: userShop._id,
      'miniAppState.updatedAt': { $gte: thirtyMinsAgo },
    });
    if (activeSellerCount < 1) activeSellerCount = 1;
  }

  const normalizedCartState = { ...normalizeCartState(user.cartState), activeSellerCount };

  res.json({
    telegramId: user.telegramId,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    shopId: userShop ? String(userShop._id) : null,
    shop: userShop ? { _id: userShop._id, name: userShop.name, city: userShop.cityId?.name || '', deliveryGroupId: userShop.deliveryGroupId, cartState: normalizedCartState } : null,
    shopName: userShop?.name || user.shopName || '',
    shopNumber: user.shopNumber,
    shopCity: userShop?.cityId?.name || '',
    deliveryGroupId: resolvedGroupId,
    warehouseZone: await resolveWarehouseZone(user),
    isWarehouseManager: user.isWarehouseManager || false,
    isOnShift: user.isOnShift || false,
    shiftZone: user.shiftZone || { startBlock: null, endBlock: null },
    sessionOpenAt,
    miniAppState: normalizeMiniAppState(user.miniAppState || {
      lastViewedProductId: '',
      currentIndex: 0,
      updatedAt: null,
    }),
  });
});

// PATCH /api/v1/telegram/me/shop — seller оновлює свій магазин.
// Якщо є активне замовлення — воно автоматично переноситься до нового магазину.
// Кошик (cartState.orderItems) НЕ очищається — слідує за продавцем.
// Усі записи (User, Order, PickingTask) виконуються в одній транзакції MongoDB,
// щоб збій між кроками не залишив User та Order у різних магазинах.
router.patch('/me/shop', async (req, res) => {
  try {
    const user = req.telegramUser;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'shopId є обовʼязковим' });

    const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
    if (!shop) return res.status(404).json({ error: 'Магазин не знайдено' });

    // Same shop — short-circuit, just return current state
    if (user.shopId && String(user.shopId) === String(shop._id)) {
      const fresh = await User.findById(user._id).lean();
      return res.json({
        shopId: String(shop._id),
        shopName: shop.name || '',
        shopCity: shop.cityId?.name || '',
        deliveryGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : null,
        warehouseZone: fresh?.warehouseZone || '',
        cartState: normalizeCartState(fresh?.cartState ?? null),
      });
    }

    const { migrateSellerShop } = require('../../services/migrateSellerShop');
    const mongoose = require('mongoose');

    let migrationResult = null;
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        migrationResult = await migrateSellerShop({
          session,
          existingUser: user,
          newShopFull: shop,
          actor: user,
          reason: 'seller_changed_shop',
          resetCartItems: false,
          resetCartNavigation: true,
          clearCartReservation: true,
          pushHistory: false, // me/shop is a self-action — no admin audit entry
          updateLastSeller: false,
        });
      });
    } finally {
      session.endSession();
    }

    // Notify dashboards AFTER commit
    if (migrationResult?.movedOrder) {
      try {
        const io = getIO();
        if (io) {
          const { prevGroupId, newGroupId } = migrationResult;
          if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
          if (newGroupId && newGroupId !== prevGroupId) {
            io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
            io.emit('delivery_groups_updated');
          }
          io.emit('user_order_updated', { buyerTelegramId: user.telegramId });
        }
      } catch (e) {
        console.warn('[PATCH /me/shop] socket emit failed:', e?.message);
      }
    }

    const updatedUser = migrationResult?.updatedUser;
    res.json({
      shopId: String(shop._id),
      shopName: shop.name || '',
      shopCity: shop.cityId?.name || '',
      deliveryGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : null,
      warehouseZone: updatedUser?.warehouseZone || '',
      cartState: normalizeCartState(updatedUser?.cartState ?? null),
      ...(migrationResult?.movedOrder ? { orderMoved: true } : {}),
    });
  } catch (err) {
    console.error('[PATCH /v1/telegram/me/shop]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/telegram/mini-app/state — зберегти навігаційний стан (User) і кошик (Shop)
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
router.post('/mini-app/state', async (req, res) => {
  const { currentIndex, currentPage, productId, orderItems, orderItemIds, viewMode } = req.body;
  const telegramId = req.telegramId;

  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    return res.status(400).json({ error: 'currentIndex must be a non-negative integer' });
  }
  if (!Number.isInteger(currentPage) || currentPage < 0) {
    return res.status(400).json({ error: 'currentPage must be a non-negative integer' });
  }

  const MAX_CART_ITEMS = 200; // reasonable upper bound per user cart

  const sanitizedOrderItems = typeof orderItems === 'object' && orderItems !== null
    ? Object.fromEntries(
        Object.entries(orderItems)
          .slice(0, MAX_CART_ITEMS)
          .map(([pid, qty]) => [String(pid), Math.min(1000, Math.max(0, Number(qty) || 0))]),
      )
    : {};
  const sanitizedOrderItemIds = Array.isArray(orderItemIds)
    ? orderItemIds.slice(0, MAX_CART_ITEMS).map((id) => String(id))
    : [];

  const validViewMode = viewMode === 'grid' ? 'grid' : 'carousel';

  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        'miniAppState.viewMode': validViewMode,
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

  // Кошик зберігається на продавці (User), а не на магазині — кожен має ізольований кошик
  let cartState = normalizeCartState(null);
  if (user) {
    const modifierName = [user.firstName, user.lastName].filter(Boolean).join(' ') || String(telegramId);

    // Optimistic concurrency control for cart writes.
    // Two browser tabs can race: each holds its own snapshot, both POST a "full"
    // orderItems object, and the later one silently overwrites the earlier one's
    // additions. To prevent that, the client SHOULD send `clientCartUpdatedAt`
    // (the value it last received from the server). If it is older than what's
    // currently stored, we reject the write with 409 and return the latest cart
    // so the client can merge and retry.
    //
    // Backwards compatible: if `clientCartUpdatedAt` is omitted, the request
    // proceeds as before (last-write-wins). New client always sends it.
    const clientCartUpdatedAtRaw = req.body?.clientCartUpdatedAt;
    const clientCartUpdatedAt = clientCartUpdatedAtRaw ? new Date(clientCartUpdatedAtRaw) : null;
    const enforceLock = clientCartUpdatedAt && !Number.isNaN(clientCartUpdatedAt.getTime());

    const filter = { telegramId };
    if (enforceLock) {
      // Match if server's stored timestamp is null OR <= the client's snapshot.
      // (A future bigger timestamp means another writer won the race.)
      filter.$or = [
        { 'cartState.updatedAt': null },
        { 'cartState.updatedAt': { $lte: clientCartUpdatedAt } },
      ];
    }

    const updatedUser = await User.findOneAndUpdate(
      filter,
      {
        $set: {
          'cartState.orderItems': sanitizedOrderItems,
          'cartState.orderItemIds': sanitizedOrderItemIds,
          'cartState.lastViewedProductId': String(productId || ''),
          'cartState.currentIndex': currentIndex,
          'cartState.currentPage': currentPage,
          'cartState.updatedAt': new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!updatedUser && enforceLock) {
      // Either the user vanished (extremely unlikely — they passed auth) or the
      // optimistic lock failed. Re-read and decide.
      const current = await User.findOne({ telegramId }).lean();
      if (current) {
        return res.status(409).json({
          error: 'cart_stale',
          message: 'Кошик було оновлено в іншій вкладці. Стан синхронізовано — повторіть дію.',
          cartState: normalizeCartState(current.cartState),
          miniAppState: normalizeMiniAppState(current.miniAppState),
        });
      }
    }

    if (updatedUser) {
      cartState = normalizeCartState(updatedUser.cartState);
      const io = getIO();
      if (io && user.shopId) {
        // Notify picking-group watchers of cart change
        const shopDoc = await Shop.findById(user.shopId).select('deliveryGroupId').lean();
        const groupId = shopDoc?.deliveryGroupId;
        try {
          if (groupId) io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId: String(groupId) });
        } catch (_) { /* non-critical */ }

        // Broadcast to shop room — clients filter out their own events by telegramId
        try {
          const shopRoom = `shop_${String(user.shopId)}`;
          const itemCount = sanitizedOrderItemIds.length;
          io.to(shopRoom).emit('shop_cart_changed', {
            shopId: String(user.shopId),
            modifiedBy: { telegramId: String(telegramId), name: modifierName },
            updatedAt: cartState.updatedAt,
            itemCount,
          });
        } catch (_) { /* non-critical */ }
      }
    }
  }

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState), cartState });
});

// POST /api/v1/telegram/mini-app/reset-state — очистити кошик магазину і навігаційний стан продавця
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
router.post('/mini-app/reset-state', async (req, res) => {
  const telegramId = req.telegramId;

  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        'miniAppState.currentIndex': 0,
        'miniAppState.lastViewedProductId': '',
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

  // Очищаємо кошик продавця (тепер зберігається в User)
  let cartState = normalizeCartState(null);
  if (user && user.shopId) {
    const updatedUser = await User.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          'cartState.orderItems': {},
          'cartState.orderItemIds': [],
          'cartState.lastOrderPositions': 0,
          'cartState.lastViewedProductId': '',
          'cartState.currentIndex': 0,
          'cartState.currentPage': 0,
          'cartState.updatedAt': new Date(),
        },
      },
      { new: true }
    ).lean();
    if (updatedUser) cartState = normalizeCartState(updatedUser.cartState);

    // Keep picking dashboards fresh when cart is explicitly reset.
    const io = getIO();
    if (io) {
      try {
        const shopDoc = await Shop.findById(user.shopId).select('deliveryGroupId').lean();
        const groupId = shopDoc?.deliveryGroupId;
        if (groupId) io.to(`picking_group_${String(groupId)}`).emit('shop_status_changed', { groupId: String(groupId) });
      } catch (_) { /* non-critical */ }

      try {
        io.to(`shop_${String(user.shopId)}`).emit('shop_cart_changed', {
          shopId: String(user.shopId),
          modifiedBy: {
            telegramId: String(telegramId),
            name: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(telegramId),
          },
          updatedAt: cartState.updatedAt,
          itemCount: 0,
        });
      } catch (_) { /* non-critical */ }
    }
  }

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState), cartState });
});

router.post('/register-request', async (req, res) => {
  const { firstName, lastName, phoneNumber, shopId, role } = req.body;

  const { valid, parsedData, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) {
    return res.status(401).json({ error: error || 'Invalid initData' });
  }

  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram user id is missing' });
  }

  if (!firstName || !lastName || !role) {
    return res.status(400).json({ error: "Будь ласка, заповніть всі обов'язкові поля" });
  }
  if (!['seller', 'warehouse'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role selected' });
  }
  if (role === 'seller' && !shopId) {
    return res.status(400).json({ error: "Магазин є обов'язковим для продавця" });
  }

  const existingUser = await User.findOne({ telegramId }).lean();
  if (existingUser) {
    return res.status(409).json({ error: 'User already registered' });
  }

  const existingRequest = await RegistrationRequest.findOne({
    telegramId,
    status: { $in: ['pending', 'blocked', 'rejected'] },
  }).lean();
  if (existingRequest) {
    if (existingRequest.status === 'blocked') {
      return res.status(403).json({ error: 'Registration request blocked', message: 'Ваша реєстрація заблокована.' });
    }
    if (existingRequest.status === 'rejected') {
      // Allow re-submission: delete old rejected request first
      await RegistrationRequest.findByIdAndDelete(existingRequest._id);
    } else {
      return res.status(409).json({ error: 'Registration request already exists' });
    }
  }

  let shop = null;
  let group = null;
  if (role === 'seller') {
    shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
    if (!shop || !shop.isActive) {
      return res.status(400).json({ error: 'Магазин не знайдено' });
    }
    if (!shop.deliveryGroupId) {
      return res.status(400).json({ error: "Магазин не прив'язаний до групи доставки" });
    }
    group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    if (!group) {
      return res.status(400).json({ error: 'Групу доставки магазину не знайдено' });
    }
  }

  const cleanPhone = phoneNumber ? String(phoneNumber).trim() : '';

  const request = await RegistrationRequest.create({
    telegramId,
    firstName,
    lastName,
    phoneNumber: cleanPhone,
    shopId:          role === 'seller' ? String(shop._id) : null,
    shopName:        role === 'seller' ? shop.name        : '',
    shopCity:        role === 'seller' ? (shop.cityId?.name || '') : '',
    deliveryGroupId: role === 'seller' ? shop.deliveryGroupId : '',
    role,
    status: 'pending',
    meta: { submittedAt: new Date() },
  });

  const roleLabel = role === 'warehouse' ? 'Склад' : 'Продавець';
  const message = `📥 Нова заявка на реєстрацію (${roleLabel}):\n` +
    `Telegram ID: ${telegramId}\n` +
    `Ім'я: ${firstName}\n` +
    `Прізвище: ${lastName}\n` +
    (cleanPhone ? `Телефон: ${cleanPhone}\n` : '') +
    `Роль: ${roleLabel}\n` +
    (role === 'seller'
      ? `Назва магазину: ${shop.name}\nМісто: ${shop.cityId?.name || 'не вказано'}\nГрупа доставки: ${group.name} (${DAY_SHORT[group.dayOfWeek] || 'День'})\n`
      : '') +
    `Запит створено: ${new Date().toLocaleString()}`;

  sendAdminNotification(message, request._id.toString()).catch(() => {});

  res.status(201).json({ requestId: request._id, status: 'pending' });
});

router.get('/register-requests', adminOnly, async (req, res) => {
  const status = String(req.query.status || 'pending');
  const allowedStatuses = ['pending', 'rejected', 'blocked', 'approved', 'all'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  const filter = status === 'all' ? {} : { status };
  const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).lean();
  res.json(requests);
});

router.post('/register-requests/:id/approve', adminOnly, async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }
  // Admin may override shopId at approve time (e.g. seller picked wrong shop)
  if (req.body.shopId) {
    request.shopId = req.body.shopId;
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

  // Resolve shopId → actual Shop document to get fresh data and validate it still exists
  let resolvedShopId = null;
  let resolvedShopName = request.shopName || '';
  let resolvedShopCity = request.shopCity || '';
  let resolvedDeliveryGroupId = request.role === 'seller' ? request.deliveryGroupId || '' : '';
  let resolvedWarehouseZone = '';

  if (request.role === 'seller' && request.shopId) {
    const shop = await Shop.findOne({ _id: request.shopId, isActive: true }).populate('cityId', 'name').lean();
    if (!shop) {
      return res.status(400).json({ error: 'shop_not_found', message: 'Магазин не знайдено або він неактивний. Оновіть заявку.' });
    }
    resolvedShopId = shop._id;
    resolvedShopName = shop.name || '';
    resolvedShopCity = shop.cityId?.name || '';
    resolvedDeliveryGroupId = shop.deliveryGroupId || resolvedDeliveryGroupId;
    if (resolvedDeliveryGroupId) {
      const grp = await DeliveryGroup.findById(resolvedDeliveryGroupId).lean();
      resolvedWarehouseZone = grp?.name || '';
    }
  }

  const user = await User.findOneAndUpdate(
    { telegramId: request.telegramId },
    {
      $setOnInsert: {
        telegramId: request.telegramId,
        role: request.role,
        firstName: request.firstName,
        lastName: request.lastName,
        phoneNumber: request.phoneNumber || '',
        shopId: resolvedShopId,
        shopName: resolvedShopName,
        shopCity: resolvedShopCity,
        deliveryGroupId: resolvedDeliveryGroupId,
        warehouseZone: resolvedWarehouseZone,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!user) {
    return res.status(409).json({ error: 'User already registered' });
  }
  await RegistrationRequest.findByIdAndDelete(req.params.id);

  await sendRegistrationApprovedMessage(user.telegramId, user.role).catch((err) => {
    console.warn('Failed to send registration approval notification', err?.message || err);
  });

  res.json({ message: 'User approved', telegramId: user.telegramId, role: user.role });
});

router.post('/register-requests/:id/reject', adminOnly, async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }
  // Mark as rejected so the user sees "заявку відхилено" in Mini App and can re-submit
  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'rejected' });
  res.json({ message: 'Registration request rejected', telegramId: request.telegramId });
});

router.post('/register-requests/:id/block', adminOnly, async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ error: 'Pending registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'blocked' });
  res.json({ message: 'Registration request blocked', telegramId: request.telegramId });
});

router.post('/register-requests/:id/unblock', adminOnly, async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request || request.status !== 'blocked') {
    return res.status(404).json({ error: 'Blocked registration request not found' });
  }

  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'pending' });
  res.json({ message: 'Registration request unblocked', telegramId: request.telegramId });
});

router.delete('/register-requests/:id', adminOnly, async (req, res) => {
  const request = await RegistrationRequest.findByIdAndDelete(req.params.id).lean();
  if (!request) {
    return res.status(404).json({ error: 'Registration request not found' });
  }

  res.json({ message: 'Registration request deleted', telegramId: request.telegramId });
});

module.exports = router;