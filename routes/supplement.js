'use strict';

/**
 * API дозамовлень.
 *
 * Дві аудиторії, один набір правил:
 *   • продавець — бачить активні пропозиції СВОЄЇ групи і керує заявкою СВОГО
 *     магазину (§10);
 *   • склад — бачить віртуальний блок, ставить галочки і закриває пропозицію (§8, §12).
 *
 * Усі серверні інваріанти §21 живуть тут або в services/supplementOffers.js:
 *   • дедлайн перевіряється в КОЖНІЙ операції продавця (effectiveOfferStatus),
 *     а не тільки планувальником;
 *   • одна заявка на (offerId, shopId) — унікальний індекс + upsert;
 *   • продавець торкається лише свого магазину і лише своєї групи;
 *   • «Спакував» перевіряється сервером (frozen + усі packed);
 *   • completed більше не приймає змін.
 */

const express = require('express');
const mongoose = require('mongoose');

const Shop  = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');

const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { assignLateShopNumber, buildShopNumberLookup } = require('../utils/shopNumbering');
const { getIO } = require('../socket');
const {
  ACTIVE_STATUSES,
  effectiveOfferStatus,
  isOfferOpenForSellers,
  resolveProductLocations,
  formatLocation,
  productView,
  offerViewForWarehouse,
  completeOffer,
  findActiveOffersForGroup,
  loadProductsFor,
} = require('../services/supplementOffers');

const router = express.Router();

const sellerRoles    = requireTelegramRoles(['seller', 'admin']);
const warehouseRoles = requireTelegramRoles(['warehouse', 'admin']);

const MIN_QTY = 1;
// Та сама межа, що й у звичайному каталозі (routes/orders.js) — §10.
const MAX_QTY = Number(process.env.MAX_QTY_PER_PRODUCT) || 6;

function actorOf(user) {
  return {
    by: String(user?.telegramId || ''),
    byName: [user?.firstName, user?.lastName].filter(Boolean).join(' '),
    byRole: user?.role || '',
  };
}

function emit(event, payload) {
  try {
    const io = getIO();
    if (io) io.emit(event, payload);
  } catch { /* сокет може бути вимкнений */ }
}

/**
 * Контекст продавця: його магазин, група і ПОТОЧНА сесія цієї групи.
 * Саме проти цієї пари (група + сесія) звіряються всі пропозиції — цього
 * достатньо, щоб продавець не міг дотягнутися до чужої групи навіть прямим
 * запитом з підставленим offerId (§21).
 */
async function sellerContext(user) {
  if (!user?.shopId) throw appError('no_shop');
  const shop = await Shop.findById(user.shopId).lean();
  if (!shop?.deliveryGroupId) throw appError('no_delivery_group');
  const group = await DeliveryGroup.findById(shop.deliveryGroupId, 'name dayOfWeek').lean();
  if (!group) throw appError('delivery_group_not_found');

  const schedule = await getOrderingSchedule();
  const orderingSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);

  return {
    shopId: String(shop._id),
    shopName: shop.name || '',
    deliveryGroupId: String(group._id),
    groupName: group.name || '',
    orderingSessionId,
  };
}

/** Пропозиція + перевірка, що вона справді адресована цьому продавцю. */
async function loadOfferForSeller(offerId, ctx) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(offerId);
  if (!offer) throw appError('supplement_offer_not_found');
  if (String(offer.deliveryGroupId) !== ctx.deliveryGroupId
      || String(offer.orderingSessionId) !== String(ctx.orderingSessionId)) {
    throw appError('supplement_wrong_group');
  }
  return offer;
}

// ─── ПРОДАВЕЦЬ ───────────────────────────────────────────────────────────────

/**
 * GET /api/supplement/available
 * Активні пропозиції для магазину продавця + його поточна заявка на кожну.
 *
 * Показується НЕЗАЛЕЖНО від того, відкрите звичайне вікно замовлень чи ні:
 * увесь сенс дозамовлення в тому, що воно живе після закриття вікна (§10).
 * Старий каталог при цьому НЕ відкривається — це окремий список.
 */
router.get('/available', sellerRoles, asyncHandler(async (req, res) => {
  const ctx = await sellerContext(req.telegramUser);

  const offers = await SupplementOffer.find({
    deliveryGroupId: ctx.deliveryGroupId,
    orderingSessionId: ctx.orderingSessionId,
    status: { $in: ACTIVE_STATUSES },
  }).sort({ closesAt: 1, createdAt: 1 }).lean();

  if (!offers.length) return res.json({ offers: [], serverTime: new Date().toISOString() });

  const [productMap, myRequests] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offers.map((o) => o._id) }, shopId: ctx.shopId }).lean(),
  ]);
  const requestByOffer = new Map(myRequests.map((r) => [String(r.offerId), r]));

  const now = new Date();
  res.json({
    // serverTime — щоб зворотний відлік у мініаппі рахувався від СЕРВЕРНОГО
    // часу. Годинник телефона може бути зсунутий, а рішення про закриття
    // приймає сервер; без цього таймер показував би одне, а API відповідав інше.
    serverTime: now.toISOString(),
    shopId: ctx.shopId,
    // Клієнт фільтрує широкомовні сокет-події за цими двома — інакше кожен
    // продавець перечитував би список на кожну чужу заявку в системі.
    deliveryGroupId: ctx.deliveryGroupId,
    groupName: ctx.groupName,
    offers: offers.map((offer) => {
      const mine = requestByOffer.get(String(offer._id)) || null;
      return {
        offerId: String(offer._id),
        status: effectiveOfferStatus(offer, now),
        closesAt: offer.closesAt,
        product: productView(productMap.get(String(offer.productId))),
        myQuantity: mine?.quantity ?? 0,
        // Клієнт не має відтворювати правило блокування — сервер каже прямо.
        locked: !!mine?.packed,
        packedAt: mine?.packedAt || null,
      };
    }),
  });
}));

/**
 * POST /api/supplement/:offerId/request  { quantity: 1..6 }
 * Створити або змінити заявку СВОГО магазину.
 *
 * Заявка належить магазину: upsert по (offerId, shopId), тож два продавці одного
 * магазину працюють з одним рядком, а не створюють два (§10, §21, §22 тест 4).
 */
router.post('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const offer = await loadOfferForSeller(req.params.offerId, ctx);

  const quantity = Math.trunc(Number(req.body?.quantity));
  if (!Number.isFinite(quantity) || quantity < MIN_QTY || quantity > MAX_QTY) {
    throw appError('supplement_quantity_invalid');
  }

  // Дедлайн — рішення СЕРВЕРА, навіть якщо планувальник ще не поставив frozen (§21).
  if (!isOfferOpenForSellers(offer)) throw appError('supplement_closed');

  const actor = actorOf(user);
  const existing = await SupplementRequest.findOne({ offerId: offer._id, shopId: ctx.shopId });

  // Жорстке блокування після packed (рішення власника): склад уже фізично
  // поклав товар у коробку — міняти кількість пізно.
  if (existing?.packed) throw appError('supplement_request_locked');

  let request;
  if (existing) {
    if (existing.quantity === quantity) {
      return res.json({ ok: true, quantity, action: 'noop' });
    }
    const from = existing.quantity;
    existing.quantity = quantity;
    existing.updatedBy = actor.by;
    existing.updatedByName = actor.byName;
    existing.history.push({ ...actor, action: 'quantity_changed', meta: { from, to: quantity } });
    request = await existing.save();
  } else {
    try {
      request = await SupplementRequest.create({
        offerId: offer._id,
        shopId: ctx.shopId,
        shopName: ctx.shopName,
        deliveryGroupId: ctx.deliveryGroupId,
        orderingSessionId: ctx.orderingSessionId,
        quantity,
        createdBy: actor.by,
        createdByName: actor.byName,
        updatedBy: actor.by,
        updatedByName: actor.byName,
        history: [{ ...actor, action: 'created', meta: { quantity } }],
      });
    } catch (err) {
      // Гонка двох продавців одного магазину: унікальний індекс віддав перемогу
      // першому. Другий не створює дубль — він оновлює те, що вже є.
      if (err?.code !== 11000) throw err;
      const won = await SupplementRequest.findOne({ offerId: offer._id, shopId: ctx.shopId });
      if (!won) throw err;
      if (won.packed) throw appError('supplement_request_locked');
      won.quantity = quantity;
      won.updatedBy = actor.by;
      won.updatedByName = actor.byName;
      won.history.push({ ...actor, action: 'quantity_changed', meta: { to: quantity, raced: true } });
      request = await won.save();
    }
  }

  // Магазин, який не мав основного замовлення, не має і номера коробки. Якщо
  // номери вже заморожені (збирання почалось) — дістає наступний вільний у
  // хвіст, існуючі не пересортовуються (§11). Якщо ще не заморожені, функція
  // нічого не робить: старт збирання пронумерує його разом з усіма.
  assignLateShopNumber(ctx.orderingSessionId, ctx.shopId, ctx.shopName)
    .catch((err) => console.warn('[supplement] нумерація коробки не вдалась:', err.message));

  emit('supplement_request_changed', {
    offerId: String(offer._id),
    deliveryGroupId: ctx.deliveryGroupId,
    shopId: ctx.shopId,
    action: existing ? 'updated' : 'created',
  });
  emit('user_order_updated', { buyerTelegramId: String(user.telegramId) });

  res.json({ ok: true, quantity: request.quantity, action: existing ? 'updated' : 'created' });
}));

/**
 * DELETE /api/supplement/:offerId/request — прибрати заявку магазину.
 * Ті самі гарди: дедлайн і жорстке блокування після packed.
 */
router.delete('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const offer = await loadOfferForSeller(req.params.offerId, ctx);

  if (!isOfferOpenForSellers(offer)) throw appError('supplement_closed');

  const existing = await SupplementRequest.findOne({ offerId: offer._id, shopId: ctx.shopId });
  if (!existing) return res.json({ ok: true, action: 'noop' });
  if (existing.packed) throw appError('supplement_request_locked');

  await existing.deleteOne();

  emit('supplement_request_changed', {
    offerId: String(offer._id),
    deliveryGroupId: ctx.deliveryGroupId,
    shopId: ctx.shopId,
    action: 'cancelled',
  });
  emit('user_order_updated', { buyerTelegramId: String(user.telegramId) });

  res.json({ ok: true, action: 'cancelled' });
}));

/**
 * GET /api/supplement/my — заявки мого магазину для «Моїх замовлень» (§11).
 * Заявка показується ОДРАЗУ після створення, а не тільки після заморозки.
 * Вікно — 30 днів, як і в основній історії замовлень.
 */
router.get('/my', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user?.shopId) return res.json({ requests: [] });

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const requests = await SupplementRequest.find({
    shopId: user.shopId,
    createdAt: { $gte: since },
  }).sort({ createdAt: -1 }).limit(100).lean();

  if (!requests.length) return res.json({ requests: [] });

  const offers = await SupplementOffer.find(
    { _id: { $in: requests.map((r) => r.offerId) } },
  ).lean();
  const offerById = new Map(offers.map((o) => [String(o._id), o]));
  const productMap = await loadProductsFor(offers);

  const now = new Date();
  res.json({
    serverTime: now.toISOString(),
    requests: requests.map((r) => {
      const offer = offerById.get(String(r.offerId));
      return {
        requestId: String(r._id),
        offerId: String(r.offerId),
        createdAt: r.createdAt,
        quantity: r.quantity,
        packed: !!r.packed,
        status: offer ? effectiveOfferStatus(offer, now) : 'completed',
        closesAt: offer?.closesAt || null,
        product: productView(offer ? productMap.get(String(offer.productId)) : null),
        shopName: r.shopName || '',
      };
    }),
  });
}));

// ─── СКЛАД ───────────────────────────────────────────────────────────────────

/**
 * GET /api/supplement/group/:deliveryGroupId
 * Зведення для віртуального блока (§8): скільки активних пропозицій і скільки
 * штук у них. Блок існує в UI лише поки цей список непорожній.
 */
router.get('/group/:deliveryGroupId', warehouseRoles, asyncHandler(async (req, res) => {
  const groupId = String(req.params.deliveryGroupId || '');
  const offers = await findActiveOffersForGroup(groupId);
  if (!offers.length) return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString() });

  const offerIds = offers.map((o) => o._id);
  const [productMap, requests, locations] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offerIds } }, 'offerId quantity packed').lean(),
    resolveProductLocations(offers.map((o) => o.productId)),
  ]);

  const byOffer = new Map();
  for (const r of requests) {
    const key = String(r.offerId);
    if (!byOffer.has(key)) byOffer.set(key, []);
    byOffer.get(key).push(r);
  }

  const now = new Date();
  const list = offers.map((offer) => {
    const rows = byOffer.get(String(offer._id)) || [];
    const status = effectiveOfferStatus(offer, now);
    const location = locations.get(String(offer.productId));
    return {
      offerId: String(offer._id),
      status,
      closesAt: offer.closesAt,
      product: productView(productMap.get(String(offer.productId))),
      locationLabel: formatLocation(location),
      shopCount: rows.length,
      totalQty: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
      packedCount: rows.filter((r) => r.packed).length,
      canComplete: status === 'frozen' && rows.length > 0 && rows.every((r) => r.packed),
    };
  });

  res.json({
    serverTime: now.toISOString(),
    offers: list,
    totalQty: list.reduce((s, o) => s + o.totalQty, 0),
  });
}));

/** Спільна збірка повної картки — використовується GET і після кожної мутації. */
async function buildOfferCard(offer) {
  const [requests, locations, productMap, session] = await Promise.all([
    SupplementRequest.find({ offerId: offer._id }).lean(),
    resolveProductLocations([offer.productId]),
    loadProductsFor([offer]),
    OrderingSession.findById(offer.orderingSessionId, 'shopNumbers').lean(),
  ]);
  const lookup = buildShopNumberLookup(session?.shopNumbers);
  return offerViewForWarehouse(offer, {
    product: productMap.get(String(offer.productId)),
    requests,
    location: locations.get(String(offer.productId)),
    boxNumberFor: (r) => lookup.byId.get(String(r.shopId))
      ?? lookup.byName.get(String(r.shopName || ''))
      ?? null,
  });
}

/** GET /api/supplement/offers/:offerId — повна картка для пакування. */
router.get('/offers/:offerId', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(req.params.offerId).lean();
  if (!offer) throw appError('supplement_offer_not_found');
  res.json({ offer: await buildOfferCard(offer), serverTime: new Date().toISOString() });
}));

/**
 * PATCH /api/supplement/requests/:requestId/packed  { packed: boolean }
 *
 * Склад може пакувати ще поки пропозиція open (§12) — заборонено лише фінальне
 * завершення. Кожна галочка — атомарний запис В СВІЙ документ, тому паралельна
 * поява нового магазину не стирає вже поставлені галочки (§22 тест 5).
 */
router.patch('/requests/:requestId/packed', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.requestId)) throw appError('supplement_request_not_found');
  const packed = req.body?.packed !== false;
  const actor = actorOf(req.telegramUser);

  const request = await SupplementRequest.findById(req.params.requestId);
  if (!request) throw appError('supplement_request_not_found');

  const offer = await SupplementOffer.findById(request.offerId).lean();
  if (!offer) throw appError('supplement_offer_not_found');
  // Завершена пропозиція більше не приймає змін — ні від продавця, ні від складу (§21).
  if (offer.status === 'completed') throw appError('supplement_closed');

  if (request.packed !== packed) {
    request.packed = packed;
    request.packedBy = packed ? actor.by : '';
    request.packedByName = packed ? actor.byName : '';
    request.packedAt = packed ? new Date() : null;
    request.history.push({ ...actor, action: packed ? 'packed' : 'unpacked', meta: { quantity: request.quantity } });
    await request.save();
  }

  emit('supplement_packed_changed', {
    offerId: String(offer._id),
    deliveryGroupId: String(offer.deliveryGroupId),
    requestId: String(request._id),
    // shopId — щоб продавець перечитав свою картку ЛИШЕ коли спакували саме
    // його магазин (галочка складу блокує йому зміну кількості), а не на кожну
    // галочку по всіх магазинах групи.
    shopId: String(request.shopId),
    packed,
  });

  res.json({ offer: await buildOfferCard(offer) });
}));

/**
 * POST /api/supplement/offers/:offerId/complete — «Спакував».
 * Умови перевіряє сервер (services/supplementOffers.completeOffer):
 * frozen + є заявки + усі packed. До заморозки завершити не можна (§18).
 */
router.post('/offers/:offerId/complete', warehouseRoles, asyncHandler(async (req, res) => {
  try {
    await completeOffer(req.params.offerId, actorOf(req.telegramUser));
  } catch (err) {
    if (err?.code && String(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  res.json({ ok: true });
}));

module.exports = router;
