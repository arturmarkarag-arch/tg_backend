const express = require('express');
const { validateTelegramInitData, getInitDataFromRequest, getTelegramId, getTelegramAuth } = require('../../utils/validateTelegramInitData');
const { requireTelegramRole } = require('../../middleware/telegramAuth');
const User = require('../../models/User');
const RegistrationRequest = require('../../models/RegistrationRequest');
const DeliveryGroup = require('../../models/DeliveryGroup');
const Shop = require('../../models/Shop');
const { sendAdminNotification, sendRegistrationApprovedMessage, isUserInAllowedGroup, deleteWelcomeFor } = require('../../telegramBot');
const { resolveAndCreateUser } = require('../../services/createUserFromRequest');
const { consumeRegistrationToken, issueRegistrationToken, peekRegistrationToken } = require('../../services/registrationToken');
const RegistrationToken = require('../../models/RegistrationToken');
const { issueGoogleLinkToken } = require('../../services/googleLinkToken');
const { getOrderingWindowOpenAt } = require('../../utils/orderingSchedule');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { getOrCreateSessionId } = require('../../utils/getOrCreateSession');
const Order = require('../../models/Order');
const { getIO } = require('../../socket');
const { appError, asyncHandler } = require('../../utils/errors');
const { getSupportAdmins, toPublicSupportAdmins } = require('../../utils/telegramSupportAdmins');
const { withLock } = require('../../utils/lock');
const { getShop, getDeliveryGroup } = require('../../utils/modelCache');
const { isRemovedUser } = require('../../utils/userAccountState');
const { getTelegramUsernameMap } = require('../../utils/telegramUsername');

const router = express.Router();
const adminOnly = requireTelegramRole('admin');

function normalizePhoneNumber(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('48')  && digits.length === 11) return '+' + digits;
  if (digits.startsWith('380') && digits.length === 12) return '+' + digits;
  return '+' + digits;
}

function normalizeMiniAppState(miniAppState) {
  if (!miniAppState || typeof miniAppState !== 'object') return miniAppState;
  return { ...miniAppState };
}

function normalizeCartState(cartState) {
  const defaults = {
    orderItems: {},
    orderItemIds: [],
    lastOrderPositions: 0,

    navigationSessionId: '',

    lastViewedProductId: '',
    lastViewedOrderNumber: 0,
    currentIndex: 0,
    currentPage: 0,
    updatedAt: null,
    lastModifiedByTelegramId: null,
    lastModifiedByName: null,
    activeSellerCount: 1,
  };

  if (!cartState || typeof cartState !== 'object') return defaults;

  const result = { ...defaults, ...cartState };

  if (result.orderItems instanceof Map) {
    result.orderItems = Object.fromEntries(result.orderItems);
  } else if (
    result.orderItems &&
    typeof result.orderItems === 'object' &&
    !Array.isArray(result.orderItems)
  ) {
    result.orderItems = Object.fromEntries(
      Object.entries(result.orderItems)
    );
  } else {
    result.orderItems = {};
  }

  return result;
}

async function resolveOrderingSessionContext(user, userShop = null) {
  const resolvedShop = userShop || (user?.shopId ? await getShop(user.shopId) : null);
  // Єдине джерело групи — магазин. Копії на User більше немає (див. models/User.js).
  const resolvedGroupId = resolvedShop?.deliveryGroupId || '';

  if (!['seller', 'admin'].includes(user?.role) || !resolvedGroupId) {
    return {
      resolvedGroupId,
      sessionOpenAt: null,
      orderingSessionId: '',
    };
  }

  const group = normalizeDeliveryGroup(
    await getDeliveryGroup(resolvedGroupId)
  );

  if (!group) {
    return {
      resolvedGroupId,
      sessionOpenAt: null,
      orderingSessionId: '',
    };
  }

  const sessionOpenAt = getOrderingWindowOpenAt(group.orderingSchedule).toISOString();
  const orderingSessionId = await getOrCreateSessionId(
    String(resolvedGroupId),
    group.orderingSchedule,
  );

  return {
    resolvedGroupId,
    sessionOpenAt,
    orderingSessionId,
  };
}

// shopId → shop → deliveryGroupId → group.name. Єдиний шлях: без магазину зони
// немає (поле в профілі лишається у відповіді, просто порожнє).
async function resolveWarehouseZone(user) {
  if (!user?.shopId) return '';
  const shop = await Shop.findById(user.shopId).lean();
  if (!shop?.deliveryGroupId) return '';
  const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
  return group?.name || '';
}

// Те саме для магазину, який уже прочитано (PATCH /me/shop), — без зайвого читання.
async function resolveZoneForShop(shop) {
  if (!shop?.deliveryGroupId) return '';
  const group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
  return group?.name || '';
}

// Builds the public profile payload for an authenticated user. Shared by the
// Telegram mini-app path (POST /me, initData) and the browser path
// (GET /api/v1/auth/me, JWT) so both return an identical shape.
async function buildUserProfile(user) {
  // This function is only used to bootstrap an authenticated app/browser
  // profile, so it is the canonical place to record a real app open.
  const appOpenedAt = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastAppOpenedAt: appOpenedAt } }).catch((err) => {
    console.warn('[buildUserProfile] lastAppOpenedAt update failed:', err?.message);
  });

  const userShop = user.shopId ? await getShop(user.shopId) : null;
  const fallbackGroupId = userShop?.deliveryGroupId || '';

  let resolvedGroupId = fallbackGroupId;
  let sessionOpenAt = null;
  let currentOrderingSessionId = '';

  try {
    const sessionContext = await resolveOrderingSessionContext(user, userShop);
    resolvedGroupId = sessionContext.resolvedGroupId || fallbackGroupId;
    sessionOpenAt = sessionContext.sessionOpenAt;
    currentOrderingSessionId = sessionContext.orderingSessionId;
  } catch (error) {
    console.error(
      '[buildUserProfile] Не вдалося визначити ordering session:',
      error
    );
  }

  let activeSellerCount = 1;
  if (userShop) {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    activeSellerCount = await User.countDocuments({
      shopId: userShop._id,
      'miniAppState.updatedAt': { $gte: thirtyMinsAgo },
    });
    if (activeSellerCount < 1) activeSellerCount = 1;
  }

  let catalogState = normalizeCartState(user.cartState);

  const navigationSessionChanged =
    user.role === 'seller' &&
    currentOrderingSessionId &&
    String(catalogState.navigationSessionId || '') !== currentOrderingSessionId;

  if (navigationSessionChanged) {
    const now = new Date();

    catalogState = {
      ...catalogState,
      navigationSessionId: currentOrderingSessionId,
      lastViewedProductId: '',
      lastViewedOrderNumber: 0,
      currentIndex: 0,
      currentPage: 0,
      updatedAt: now,
    };

    const resetUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        'cartState.navigationSessionId': { $ne: currentOrderingSessionId },
      },
      {
        $set: {
          'cartState.navigationSessionId': currentOrderingSessionId,
          'cartState.lastViewedProductId': '',
          'cartState.lastViewedOrderNumber': 0,
          'cartState.currentIndex': 0,
          'cartState.currentPage': 0,
          'cartState.updatedAt': now,
        },
      },
      { new: true }
    ).lean();

    if (resetUser) {
      catalogState = normalizeCartState(resetUser.cartState);
    } else {
      // Another concurrent profile request may already have reset the session and
      // the seller may even have progressed. Never overwrite that fresher state.
      const freshUser = await User.findById(user._id).lean();
      catalogState = normalizeCartState(freshUser?.cartState);
    }
  }

  const normalizedCartState = {
    ...catalogState,
    activeSellerCount,
  };

  return {
    telegramId: user.telegramId,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    phoneNumber: user.phoneNumber || '',
    googleEmail: user.googleEmail || '',
    shopId: userShop ? String(userShop._id) : null,
    shop: userShop ? { _id: userShop._id, name: userShop.name, city: userShop.cityId?.name || '', deliveryGroupId: userShop.deliveryGroupId, cartState: normalizedCartState } : null,
    // catalogState is always present regardless of role — lets admin/warehouse
    // restore their last catalog position across sessions and devices.
    orderingSessionId: currentOrderingSessionId,
    catalogState,
    shopName: userShop?.name || '',
    shopNumber: user.shopNumber,
    shopCity: userShop?.cityId?.name || '',
    deliveryGroupId: resolvedGroupId,
    warehouseZone: await resolveWarehouseZone(user),
    sessionOpenAt,
    lastAppOpenedAt: appOpenedAt,
    miniAppState: normalizeMiniAppState(user.miniAppState || {
      lastViewedProductId: '',
      currentIndex: 0,
      updatedAt: null,
    }),
  };
}

// POST /api/v1/telegram/validate — перевірити підпис initData
router.post('/validate', asyncHandler(async (req, res) => {
  const initData = getInitDataFromRequest(req);
  if (!initData) throw appError('init_data_required');

  const { valid, parsedData, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });

  const telegramId = parsedData.user?.id;
  if (!telegramId) throw appError('auth_telegram_id_missing');

  res.json({ telegramId: String(telegramId), user: parsedData.user || null });
}));

// POST /api/v1/telegram/me — перевірити initData І чи є користувач у системі
// Повертає профіль якщо є, 403 якщо немає, 401 якщо initData невалідна
router.post('/me', asyncHandler(async (req, res) => {
  const initData = getInitDataFromRequest(req);
  if (!initData) throw appError('init_data_required');

  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  const user = await User.findOne({ telegramId }).lean();
  if (!user || isRemovedUser(user)) {
    const request = await RegistrationRequest.findOne({
      telegramId,
      status: { $in: ['pending', 'blocked', 'rejected'] },
    }).lean();
    if (request?.status === 'pending')  throw appError('registration_pending');
    if (request?.status === 'blocked')  throw appError('registration_blocked');
    if (request?.status === 'rejected') throw appError('registration_rejected');
    throw appError('not_registered');
  }

  // 3. Повертаємо профіль (без чутливих полів). Shop резолвиться з кешу.
  res.json(await buildUserProfile(user));
}));

// PATCH /api/v1/telegram/me/shop — seller оновлює свій магазин.
// Якщо є активне замовлення — воно автоматично переноситься до нового магазину.
// Кошик (cartState.orderItems) НЕ очищається — слідує за продавцем.
// Усі записи (User, Order, PickingTask) виконуються в одній транзакції MongoDB,
// щоб збій між кроками не залишив User та Order у різних магазинах.
router.patch('/me/shop', asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user) throw appError('auth_required');

  const { shopId } = req.body;
  if (!shopId) throw appError('me_shop_required');

  const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!shop) throw appError('shop_not_found');

  // Same shop — short-circuit, just return current state
  if (user.shopId && String(user.shopId) === String(shop._id)) {
    const fresh = await User.findById(user._id).lean();
    return res.json({
      shopId: String(shop._id),
      shopName: shop.name || '',
      shopCity: shop.cityId?.name || '',
      deliveryGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : null,
      warehouseZone: await resolveZoneForShop(shop),
      cartState: normalizeCartState(fresh?.cartState ?? null),
    });
  }

  const { migrateSellerShop } = require('../../services/migrateSellerShop');
  const mongoose = require('mongoose');

  const migrationResult = await withLock(`user:${user.telegramId}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out = null;
      await session.withTransaction(async () => {
        const fresh = await User.findOne({ telegramId: user.telegramId }).session(session).lean();
        if (!fresh) throw appError('user_not_found');
        out = await migrateSellerShop({
          session,
          existingUser: fresh,
          newShopFull: shop,
          actor: user,
          reason: 'seller_changed_shop',
          resetCartItems: false,
          resetCartNavigation: true,
          clearCartReservation: true,
          pushHistory: false,
          updateLastSeller: false,
        });
      });
      return out;
    } finally {
      session.endSession();
    }
  });

  // Post-commit cache invalidation — done OUTSIDE withTransaction so other
  // workers don't repopulate L1 with pre-commit reads.
  if (migrationResult?.invalidate) {
    try { await migrationResult.invalidate(); }
    catch (e) { console.warn('[PATCH /me/shop] cache invalidate failed:', e?.message); }
  }

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
    warehouseZone: await resolveZoneForShop(shop),
    cartState: normalizeCartState(updatedUser?.cartState ?? null),
    ...(migrationResult?.movedOrder ? { orderMoved: true } : {}),
  });
}));

// PATCH /api/v1/telegram/me/profile — seller/warehouse оновлює власні дані
// (firstName, lastName, phoneNumber) без створення shop transfer request.
// Адмін-апрув не потрібен — це лише особисті контактні дані.
router.patch('/me/profile', asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user) throw appError('auth_required');
  if (!['seller', 'warehouse'].includes(user.role)) throw appError('forbidden');

  // Google linking is no longer a typed field here — it is proven via OAuth
  // through /auth/google/link/*. This route handles only plain contact data.
  const { firstName, lastName, phoneNumber } = req.body || {};
  const patch = {};
  if (typeof firstName === 'string') {
    const v = firstName.trim();
    if (v) patch.firstName = v;
  }
  if (typeof lastName === 'string') {
    const v = lastName.trim();
    if (v) patch.lastName = v;
  }
  if (phoneNumber !== undefined && phoneNumber !== null) {
    patch.phoneNumber = normalizePhoneNumber(phoneNumber);
  }

  if (Object.keys(patch).length === 0) throw appError('me_profile_no_changes');

  await User.updateOne({ telegramId: user.telegramId }, { $set: patch });
  const fresh = await User.findOne({ telegramId: user.telegramId }).lean();
  res.json({
    firstName: fresh?.firstName || '',
    lastName: fresh?.lastName || '',
    phoneNumber: fresh?.phoneNumber || '',
    googleEmail: fresh?.googleEmail || '',
  });
}));

// POST /api/v1/telegram/google/link/start — крок 1 безпечної прив'язки Google.
// Захищено telegramAuth → req.telegramId уже доведений initData (mini-app). Мінтимо
// одноразовий токен, що несе САМЕ цей telegramId (а не Google). Клієнт відкриє
// /link-google?t=<token> у системному браузері (Telegram.WebApp.openLink), де
// Google-вхід працює; завершення — на публічному /v1/auth/google/link/complete.
// Деталі безпеки (reverse-напрямок) — у models/GoogleLinkToken.js.
router.post('/google/link/start', asyncHandler(async (req, res) => {
  const telegramId = req.telegramId;
  if (!telegramId) throw appError('auth_required');
  const token = await issueGoogleLinkToken(telegramId);
  res.json({ token });
}));

// POST /api/v1/telegram/google/unlink — прибрати прив'язку Google від свого акаунта.
// Removing a sign-in credential ALSO evicts existing browser sessions (bump
// sessionsValidFrom): otherwise a session bootstrapped via the now-removed Google
// would linger. The mini-app (initData) is unaffected — the revocation check runs
// only on the browser/JWT path, so the user keeps managing from Telegram.
router.post('/google/unlink', asyncHandler(async (req, res) => {
  const telegramId = req.telegramId;
  if (!telegramId) throw appError('auth_required');
  await User.updateOne(
    { telegramId },
    { $set: { googleSub: '', googleEmail: '', sessionsValidFrom: new Date() } },
  );
  res.json({ ok: true });
}));

// POST /api/v1/telegram/mini-app/state — зберегти навігаційний стан продавця
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
//
// Контракт конкурентності (свідомо асиметричний):
//   orderingSessionId не збігся → HARD 409, стара сесія НІКОЛИ не перезапише нову.
//   курсор каталогу розійшовся  → last-write-wins, без 409.
// Цей endpoint є ТІЛЬКИ navigation-state. Legacy cartState.orderItems /
// orderItemIds тут навмисно не читаємо і не пишемо: реальні замовлення живуть
// в Order, а старі cart-поля ще використовуються окремими recovery/legacy
// шляхами. Курсор каталогу — last-write-wins; оптимістичний лок по
// cartState.updatedAt звідси прибрано: він
// віддавав 409 (cart_stale) на кожен keepalive-save при згортанні мініаппа,
// бо той запис рухає серверний updatedAt, а відповіді на teardown ніхто не
// читає — клієнт лишався зі старою міткою і конфліктував сам із собою.
router.post('/mini-app/state', asyncHandler(async (req, res) => {
  const {
    currentIndex,
    currentPage,
    productId,
    orderNumber,
    viewMode,
    orderingSessionId,
  } = req.body || {};
  const telegramId = req.telegramId;

  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    throw appError('me_state_invalid_index', { field: 'currentIndex' });
  }
  if (!Number.isInteger(currentPage) || currentPage < 0) {
    throw appError('me_state_invalid_index', { field: 'currentPage' });
  }

  const validViewMode = viewMode === 'grid' ? 'grid' : 'carousel';

  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    const pendingRequest = await RegistrationRequest.findOne({
      telegramId,
      status: 'pending',
    }).lean();
    if (pendingRequest) throw appError('registration_pending');
    throw appError('user_not_found');
  }

  let currentOrderingSessionId = '';
  if (user.role === 'seller') {
    try {
      const sessionContext = await resolveOrderingSessionContext(user);
      currentOrderingSessionId = sessionContext.orderingSessionId;
    } catch (error) {
      console.error(
        '[POST /mini-app/state] Не вдалося визначити ordering session:',
        error
      );
    }
  }

  // A tab opened in the previous ordering session must never overwrite the
  // navigation state of the new session. The client session id is mandatory for
  // sellers; old/stale tabs receive 409 and must reload/reset to the first item.
  if (user.role === 'seller' && currentOrderingSessionId) {
    const clientOrderingSessionId = String(orderingSessionId || '');
    if (clientOrderingSessionId !== currentOrderingSessionId) {
      let latestUser = user;
      const storedSessionId = String(user.cartState?.navigationSessionId || '');

      // Reset only when the server itself still carries the previous session. If a
      // fresh tab already progressed in the new session, an old tab must not erase it.
      if (storedSessionId !== currentOrderingSessionId) {
        const now = new Date();
        latestUser = await User.findOneAndUpdate(
          {
            telegramId,
            'cartState.navigationSessionId': { $ne: currentOrderingSessionId },
          },
          {
            $set: {
              'cartState.navigationSessionId': currentOrderingSessionId,
              'cartState.lastViewedProductId': '',
              'cartState.lastViewedOrderNumber': 0,
              'cartState.currentIndex': 0,
              'cartState.currentPage': 0,
              'cartState.updatedAt': now,
            },
          },
          { new: true }
        ).lean();

        if (!latestUser) {
          latestUser = await User.findOne({ telegramId }).lean();
        }
      }

      return res.status(409).json({
        error: 'ordering_session_changed',
        message: 'Почалася нова сесія замовлень. Каталог відкрито з першого товару.',
        orderingSessionId: currentOrderingSessionId,
        cartState: normalizeCartState(latestUser?.cartState),
        miniAppState: normalizeMiniAppState(latestUser?.miniAppState),
      });
    }
  }

  const now = new Date();
  const statePatch = {
    'miniAppState.viewMode': validViewMode,
    'miniAppState.updatedAt': now,
    // Navigation-only contract: never mutate legacy cart item snapshots here.
    'cartState.lastViewedProductId': String(productId || ''),
    'cartState.lastViewedOrderNumber': Number.isFinite(Number(orderNumber))
      ? Number(orderNumber)
      : 0,
    'cartState.currentIndex': currentIndex,
    'cartState.currentPage': currentPage,
    'cartState.updatedAt': now,
  };

  if (user.role === 'seller' && currentOrderingSessionId) {
    statePatch['cartState.navigationSessionId'] = currentOrderingSessionId;
  }

  const updatedUser = await User.findOneAndUpdate(
    { telegramId },
    { $set: statePatch },
    { new: true }
  ).lean();

  if (!updatedUser) throw appError('user_not_found');

  const cartState = normalizeCartState(updatedUser?.cartState);

  // Navigation state is private UI state. Changing currentIndex/currentPage must
  // never wake picking dashboards: no Order/Shop/session fact changed here.
  // Real order/shop mutations emit their own domain events elsewhere.
  res.json({
    orderingSessionId: currentOrderingSessionId,
    miniAppState: normalizeMiniAppState(updatedUser?.miniAppState),
    cartState,
  });
}));

// POST /api/v1/telegram/mini-app/reset-state — очистити кошик магазину і навігаційний стан продавця
// Захищено telegramAuth middleware — telegramId береться ТІЛЬКИ з req.telegramId
router.post('/mini-app/reset-state', asyncHandler(async (req, res) => {
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
    if (pendingRequest) throw appError('registration_pending');
    throw appError('user_not_found');
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
          'cartState.lastViewedOrderNumber': 0,
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
    }
  }

  res.json({ miniAppState: normalizeMiniAppState(user.miniAppState), cartState });
}));

/**
 * POST /api/v1/telegram/registration-invite
 *
 * Self-service invite for someone who opened the mini-app WITHOUT a `?regToken=`
 * in the URL — the Menu button, a saved mini-app, an old message. Until this
 * existed, only the bot's «Реєстрація в Mini App» button carried a token, so any
 * other way in dead-ended on the "не зареєстрований" banner with no form, even
 * for a legitimate member of the work group.
 *
 * Security is unchanged from the /start path — same gate, different doorway:
 *   • the id comes from validated initData (Telegram signs it; the URL is never
 *     trusted for identity),
 *   • membership is re-checked LIVE via getChatMember (fail-closed),
 *   • the minted token is bound to that same id, single-use, 24h,
 *   • /register-request still re-runs BOTH checks before creating anything.
 *
 * Idempotent-ish: an unspent token for this id is reused instead of minting a
 * new row on every mini-app open.
 */
router.post('/registration-invite', asyncHandler(async (req, res) => {
  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  // Already in the system → nothing to invite; the client should just re-auth.
  const existingUser = await User.findOne({ telegramId }, '_id accountState').lean();
  if (existingUser && !isRemovedUser(existingUser)) {
    return res.json({ eligible: false, reason: 'already_registered' });
  }

  // Blocked applicants must not be handed a fresh token to retry with.
  const request = await RegistrationRequest.findOne(
    { telegramId, status: { $in: ['pending', 'blocked'] } }, 'status',
  ).lean();
  if (request) return res.json({ eligible: false, reason: request.status });

  if (!(await isUserInAllowedGroup(telegramId))) {
    const supportAdmins = toPublicSupportAdmins(await getSupportAdmins());
    return res.json({ eligible: false, reason: 'not_in_group', supportAdmins });
  }

  // The client passes back the token it already holds (from ?regToken=). If it is
  // a SHOP invite, the form must know which shop, so it can lock the picker and
  // show the name instead. Never trust the client for the shop itself — it is
  // read from the token here and enforced again on submit.
  const heldToken = String(req.body?.token || '').trim();
  if (heldToken) {
    const owned = await peekRegistrationToken(heldToken, telegramId);
    if (owned) {
      if (owned.shopId) {
        const doc = await Shop.findById(owned.shopId).populate('cityId', 'name').lean();
        // A shop token whose shop is gone/inactive/group-less is a DEAD END, not a
        // free-choice invite: /register-request forces the token's shop and then
        // refuses it. Reporting `eligible: true, shop: null` showed the newcomer a
        // normal shop picker whose every option was ignored on submit — so say the
        // real reason instead. Falling back to a personal token is wrong too: it
        // would silently let them register onto some other shop.
        if (!doc?.isActive || !doc.deliveryGroupId) {
          return res.json({ eligible: false, reason: 'shop_inactive' });
        }
        return res.json({
          eligible: true,
          regToken: owned.token,
          shop: { shopId: String(doc._id), shopName: doc.name || '', shopCity: doc.cityId?.name || '' },
        });
      }
      return res.json({ eligible: true, regToken: owned.token, shop: null });
    }
    // Held token is dead (used/expired/foreign) — fall through and mint a fresh
    // personal one so the user is not stuck on a stale link.
  }

  const existingToken = await RegistrationToken.findOne({
    telegramId: String(telegramId), usedAt: null, expiresAt: { $gt: new Date() },
  }, 'token').lean();
  const regToken = existingToken?.token || await issueRegistrationToken(telegramId);

  res.json({ eligible: true, regToken, shop: null });
}));

router.post('/register-request', asyncHandler(async (req, res) => {
  const { firstName, lastName, phoneNumber, shopId, role, regToken } = req.body;

  const { valid, telegramId, error } = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw appError('auth_invalid_init_data', { reason: error });
  if (!telegramId) throw appError('auth_telegram_id_missing');

  if (!firstName || !lastName || !role) throw appError('registration_required_fields');
  if (!['seller', 'warehouse'].includes(role)) throw appError('registration_invalid_role');

  // ── Registration gate (defense in depth) ────────────────────────────────────
  // 1. LIVE membership: only current members of an allowed group (fail-closed —
  //    any getChatMember error counts as "not a member").
  if (!(await isUserInAllowedGroup(telegramId))) {
    const supportAdmins = toPublicSupportAdmins(await getSupportAdmins());
    throw appError('registration_not_in_group', { supportAdmins });
  }
  // 2. One-time invite token, minted server-side either for THIS telegramId
  //    (personal, from the group link / bot button) or for a SHOP (an admin's
  //    "посилання для реєстрації на магазин"). A personal token is only valid
  //    for the authenticated identity — the URL is never trusted for id — and a
  //    shop token is gated by the live check above.
  //
  //    Only PEEKED here. The actual burn happens inside the transaction that
  //    writes the User / RegistrationRequest, so a failure anywhere below leaves
  //    the link usable instead of stranding the person with a dead invite.
  const invite = await peekRegistrationToken(regToken, telegramId);
  if (!invite) throw appError('registration_token_invalid');

  // A shop invite DICTATES the shop: whatever the form sent is ignored, so a
  // newcomer physically cannot end up on the wrong shop (the client hides the
  // picker, but the enforcement has to live here, not in the UI). It also
  // implies the seller role — shop invites are not for warehouse staff.
  const forcedShopId = invite.shopId ? String(invite.shopId) : null;
  const effectiveRole = forcedShopId ? 'seller' : role;
  const effectiveShopId = forcedShopId || shopId;
  if (effectiveRole === 'seller' && !effectiveShopId) throw appError('registration_seller_shop_required');

  const existingUser = await User.findOne({ telegramId }).lean();
  if (existingUser && !isRemovedUser(existingUser)) throw appError('registration_user_exists');

  const existingRequest = await RegistrationRequest.findOne({
    telegramId,
    status: { $in: ['pending', 'blocked', 'rejected'] },
  }).lean();
  // A rejected application may be re-submitted — the old row is deleted inside
  // the transaction below, so a later failure doesn't lose it for nothing.
  let staleRejectedId = null;
  if (existingRequest) {
    if (existingRequest.status === 'blocked')  throw appError('registration_blocked');
    if (existingRequest.status === 'rejected') staleRejectedId = existingRequest._id;
    else throw appError('registration_request_exists');
  }

  const cleanPhone = normalizePhoneNumber(phoneNumber);

  let shop = null;
  let group = null;
  if (effectiveRole === 'seller') {
    shop = await Shop.findById(effectiveShopId).populate('cityId', 'name').lean();
    if (!shop || !shop.isActive) throw appError('registration_shop_inactive');
    if (!shop.deliveryGroupId)   throw appError('registration_shop_no_group');
    group = await DeliveryGroup.findById(shop.deliveryGroupId).lean();
    if (!group) throw appError('registration_group_not_found');
  }

  // ── Seller: auto-register. Group membership IS the authorization — no admin
  // step, no RegistrationRequest. (Role grants no access beyond the seller's own
  // shop; a wrong shop is later fixed via shop-transfer.) ──────────────────────
  if (effectiveRole === 'seller') {
    const mongoose = require('mongoose');
    const session = await mongoose.connection.startSession();
    let createdUser = null;
    try {
      await session.withTransaction(async () => {
        // Burn the invite in the SAME transaction as the User write: either both
        // land or neither does. Losing the race here (another tab consumed it
        // first) aborts instead of creating a second account.
        const consumed = await consumeRegistrationToken(regToken, telegramId, session);
        if (!consumed) throw appError('registration_token_invalid');
        if (staleRejectedId) {
          await RegistrationRequest.deleteOne({ _id: staleRejectedId }, { session });
        }
        const existing = await User.findOne({ telegramId }).session(session).lean();
        if (existing && !isRemovedUser(existing)) throw appError('registration_user_exists');
        createdUser = await resolveAndCreateUser({
          session,
          telegramId,
          role: 'seller',
          firstName,
          lastName,
          phoneNumber: cleanPhone,
          shopId: String(shop._id),
        });
      });
    } catch (err) {
      if (err && err.code === 11000) throw appError('registration_user_exists');
      throw err;
    } finally {
      session.endSession();
    }

    // Post-commit, best-effort side effects.
    deleteWelcomeFor(telegramId).catch((e) =>
      console.warn('[register-request] deleteWelcomeFor failed:', e?.message || e));
    sendRegistrationApprovedMessage(createdUser.telegramId, createdUser.role).catch((e) =>
      console.warn('[register-request] approved message failed:', e?.message || e));

    return res.status(201).json({ registered: true, role: 'seller', telegramId });
  }

  // ── Warehouse: still requires an admin approve ──────────────────────────────
  // Same atomicity rule as the seller branch: the invite is burnt together with
  // the RegistrationRequest, so a failed insert doesn't eat the one-time link.
  const mongooseLib = require('mongoose');
  const reqSession = await mongooseLib.connection.startSession();
  let request = null;
  try {
    await reqSession.withTransaction(async () => {
      const consumed = await consumeRegistrationToken(regToken, telegramId, reqSession);
      if (!consumed) throw appError('registration_token_invalid');
      if (staleRejectedId) {
        await RegistrationRequest.deleteOne({ _id: staleRejectedId }, { session: reqSession });
      }
      const created = await RegistrationRequest.create([{
        telegramId,
        firstName,
        lastName,
        phoneNumber: cleanPhone,
        shopId: null,
        deliveryGroupId: '',
        role: effectiveRole,
        status: 'pending',
        meta: { submittedAt: new Date() },
      }], { session: reqSession });
      request = created[0];
    });
  } finally {
    reqSession.endSession();
  }

  const message = `📥 Нова заявка на реєстрацію (Склад):\n` +
    `Telegram ID: ${telegramId}\n` +
    `Імʼя: ${firstName}\n` +
    `Прізвище: ${lastName}\n` +
    (cleanPhone ? `Телефон: ${cleanPhone}\n` : '') +
    `Роль: Склад\n` +
    `Запит створено: ${new Date().toLocaleString()}`;

  sendAdminNotification(message, request._id.toString()).catch(() => {});

  res.status(201).json({ requestId: request._id, status: 'pending' });
}));

router.get('/register-requests', adminOnly, asyncHandler(async (req, res) => {
  const status = String(req.query.status || 'pending');
  const allowedStatuses = ['pending', 'rejected', 'blocked', 'approved', 'all'];
  if (!allowedStatuses.includes(status)) throw appError('registration_status_invalid');

  const filter = status === 'all' ? {} : { status };
  const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).lean();
  const usernameMap = await getTelegramUsernameMap(requests.map((r) => r.telegramId));
  res.json(requests.map((r) => ({
    ...r,
    telegramUsername: usernameMap.get(String(r.telegramId)) || '',
  })));
}));

router.post('/register-requests/:id/approve', adminOnly, asyncHandler(async (req, res) => {
  const mongoose = require('mongoose');

  const pre = await RegistrationRequest.findById(req.params.id).lean();
  if (!pre) throw appError('registration_not_found');
  if (pre.status !== 'pending') throw appError('registration_not_pending');
  if (!pre.role) throw appError('registration_role_missing');
  if (pre.role === 'seller' && !pre.deliveryGroupId) throw appError('registration_group_missing');

  // Admin may override shopId at approve time (e.g. seller picked wrong shop)
  const overrideShopId = req.body.shopId || null;

  let userExists = false;
  let createdUser = null;

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      // Atomic gate: only ONE concurrent approve can flip pending→approved.
      // Without this, two admins (or a double-click) both passed the status
      // check and the upsert silently returned the first-created user, losing
      // the second approval's role/shop assignment.
      const request = await RegistrationRequest.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        { $set: { status: 'approved' } },
        { new: true, session },
      );
      if (!request) throw appError('registration_not_pending');
      if (overrideShopId) request.shopId = overrideShopId;

      const existing = await User.findOne({ telegramId: request.telegramId }).session(session).lean();
      if (existing && !isRemovedUser(existing)) {
        await RegistrationRequest.updateOne(
          { _id: request._id }, { $set: { status: 'rejected' } }, { session },
        );
        userExists = true;
        return; // commit the rejected state; throw after the tx
      }

      // Shared create/reactivate path. A soft-removed User row is intentionally
      // reused after the normal registration gates have passed.
      createdUser = await resolveAndCreateUser({
        session,
        telegramId: request.telegramId,
        role: request.role,
        firstName: request.firstName,
        lastName: request.lastName,
        phoneNumber: request.phoneNumber,
        shopId: request.role === 'seller' ? request.shopId : null,
      });

      await RegistrationRequest.deleteOne({ _id: request._id }, { session });
    });
  } catch (err) {
    if (err && err.code === 11000) throw appError('registration_user_exists');
    throw err;
  } finally {
    session.endSession();
  }

  if (userExists) throw appError('registration_user_exists');

  // Remove the group "register here" welcome now that they're in the system.
  deleteWelcomeFor(createdUser.telegramId).catch((err) =>
    console.warn('[approve] deleteWelcomeFor failed:', err?.message || err));

  await sendRegistrationApprovedMessage(createdUser.telegramId, createdUser.role).catch((err) => {
    console.warn('[approve] sendRegistrationApprovedMessage failed:', err?.message || err);
  });

  res.json({ message: 'Заявку схвалено', telegramId: createdUser.telegramId, role: createdUser.role });
}));

router.post('/register-requests/:id/reject', adminOnly, asyncHandler(async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request) throw appError('registration_not_found');
  if (request.status !== 'pending') throw appError('registration_not_pending');
  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'rejected' });
  res.json({ message: 'Заявку відхилено', telegramId: request.telegramId });
}));

router.post('/register-requests/:id/block', adminOnly, asyncHandler(async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request) throw appError('registration_not_found');
  if (request.status !== 'pending') throw appError('registration_not_pending');
  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'blocked' });
  res.json({ message: 'Заявку заблоковано', telegramId: request.telegramId });
}));

router.post('/register-requests/:id/unblock', adminOnly, asyncHandler(async (req, res) => {
  const request = await RegistrationRequest.findById(req.params.id).lean();
  if (!request) throw appError('registration_not_found');
  if (request.status !== 'blocked') throw appError('registration_not_pending');
  await RegistrationRequest.findByIdAndUpdate(req.params.id, { status: 'pending' });
  res.json({ message: 'Заявку розблоковано', telegramId: request.telegramId });
}));

router.delete('/register-requests/:id', adminOnly, asyncHandler(async (req, res) => {
  const request = await RegistrationRequest.findByIdAndDelete(req.params.id).lean();
  if (!request) throw appError('registration_not_found');
  res.json({ message: 'Заявку видалено', telegramId: request.telegramId });
}));

module.exports = router;
// Reuse the same profile shape on the browser (JWT) auth path.
module.exports.buildUserProfile = buildUserProfile;