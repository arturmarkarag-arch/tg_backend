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
const User  = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const SupplementOffer = require('../models/SupplementOffer');
const Receipt = require('../models/Receipt');
const SupplementRequest = require('../models/SupplementRequest');

const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
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
  withOfferLock,
  claimOffer,
  releaseOffer,
  freezeReceiptOffers,
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
 * Контекст продавця: його магазин і його група доставки.
 *
 * Саме проти групи звіряються всі пропозиції — цього достатньо, щоб продавець не
 * дотягнувся до чужої групи навіть прямим запитом з підставленим offerId (§21).
 * СЕСІЇ ТУТ НЕМА свідомо: хвиля дозамовлення до OrderingSession не прив'язана,
 * тому продавець бачить її незалежно від того, чи існує сесія збирання, чи вона
 * вже завершена — у цьому й був сенс переробки.
 *
 * ПРО АДМІНІСТРАТОРА: дозамовлення завжди прив'язане до магазину, тому адмін
 * бачить його ЛИШЕ як продавець свого магазину. Глобальний адмін без shopId
 * отримає no_shop і порожній блок — це не помилка, а наслідок того, що заявка
 * належить магазину. Окремого адмінського перегляду по групах свідомо немає.
 */
async function sellerContext(user) {
  if (!user?.shopId) throw appError('no_shop');
  const shop = await Shop.findById(user.shopId).lean();
  if (!shop?.deliveryGroupId) throw appError('no_delivery_group');
  const group = await DeliveryGroup.findById(shop.deliveryGroupId, 'name dayOfWeek').lean();
  if (!group) throw appError('delivery_group_not_found');

  return {
    shopId: String(shop._id),
    shopName: shop.name || '',
    deliveryGroupId: String(group._id),
    groupDayOfWeek: group.dayOfWeek,
    groupName: group.name || '',
  };
}

/** Пропозиція + перевірка, що вона справді адресована цьому продавцю. */
async function loadOfferForSeller(offerId, ctx) {
  if (!mongoose.Types.ObjectId.isValid(offerId)) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(offerId);
  if (!offer) throw appError('supplement_offer_not_found');
  if (String(offer.deliveryGroupId) !== ctx.deliveryGroupId) {
    throw appError('supplement_wrong_group');
  }
  return offer;
}

/**
 * Поточна сесія групи, ЯКЩО вона вже існує — потрібна виключно для номерів
 * коробок. findCurrentSessionId, а не getOrCreateSessionId: приймання товару не
 * має створювати сесію доставки як побічний ефект, а відсутність сесії — цілком
 * нормальний стан для дозамовлення (наприклад, хвиля відкрита майбутній групі).
 *
 * @returns {Promise<string|null>}
 */
async function boxNumberSessionId(deliveryGroupId, dayOfWeek) {
  if (!Number.isInteger(dayOfWeek)) return null;
  try {
    const schedule = await getOrderingSchedule();
    return await findCurrentSessionId(deliveryGroupId, dayOfWeek, schedule);
  } catch (err) {
    console.warn('[supplement] пошук сесії для номера коробки не вдався:', err?.message);
    return null;
  }
}

// ─── ПРОДАВЕЦЬ ───────────────────────────────────────────────────────────────

/**
 * GET /api/supplement/available
 * Активні пропозиції для магазину продавця + його поточна заявка на кожну.
 *
 * Показується НЕЗАЛЕЖНО від того, відкрите звичайне вікно замовлень чи ні, і
 * незалежно від стану сесії збирання: увесь сенс дозамовлення в тому, що воно
 * живе своїм життям (§10). Старий каталог при цьому НЕ відкривається — це
 * окремий список.
 */
router.get('/available', sellerRoles, asyncHandler(async (req, res) => {
  const ctx = await sellerContext(req.telegramUser);

  const offers = await SupplementOffer.find({
    deliveryGroupId: ctx.deliveryGroupId,
    status: { $in: ACTIVE_STATUSES },
  }).sort({ createdAt: 1 }).lean();

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

  const actor = actorOf(user);

  // ── Усе під замком пропозиції ────────────────────────────────────────────
  // Перевірка дедлайну, перевірка packed і сам запис мусять бути ОДНІЄЮ
  // операцією. Інакше: продавець читає packed=false → склад ставить галочку і
  // кладе 2 шт → запит продавця дописує quantity=6. У коробці 2, у системі 6,
  // і «жорстке блокування» обійдене без жодного злого умислу. Так само запит,
  // що стартував за 50 мс до дедлайну, інакше дописав би заявку в пропозицію,
  // яку планувальник уже заморозив і закрив як порожню.
  const { action, request } = await withOfferLock(offer._id, async () => {
    // Перечитуємо ВСЕРЕДИНІ замка — те, що ми прочитали до нього, вже застаріле.
    const fresh = await SupplementOffer.findById(offer._id);
    if (!fresh) throw appError('supplement_offer_not_found');
    // Дедлайн — рішення СЕРВЕРА, навіть якщо планувальник ще не поставив frozen (§21).
    if (!isOfferOpenForSellers(fresh)) throw appError('supplement_closed');

    const existing = await SupplementRequest.findOne({ offerId: fresh._id, shopId: ctx.shopId });

    // Жорстке блокування після packed (рішення власника): склад уже фізично
    // поклав товар у коробку — міняти кількість пізно.
    if (existing?.packed) throw appError('supplement_request_locked');

    if (existing) {
      if (existing.quantity === quantity) return { action: 'noop', request: existing };
      const from = existing.quantity;
      // findOneAndUpdate з packed:false у ФІЛЬТРІ — другий замок на випадок,
      // якщо галочка складу якимось шляхом обійшла замок пропозиції.
      const updated = await SupplementRequest.findOneAndUpdate(
        { _id: existing._id, packed: false },
        {
          $set: { quantity, updatedBy: actor.by, updatedByName: actor.byName },
          $push: { history: { ...actor, at: new Date(), action: 'quantity_changed', meta: { from, to: quantity } } },
        },
        { new: true },
      );
      if (!updated) throw appError('supplement_request_locked');
      return { action: 'updated', request: updated };
    }

    try {
      const created = await SupplementRequest.create({
        offerId: fresh._id,
        shopId: ctx.shopId,
        shopName: ctx.shopName,
        deliveryGroupId: ctx.deliveryGroupId,
        quantity,
        createdBy: actor.by,
        createdByName: actor.byName,
        updatedBy: actor.by,
        updatedByName: actor.byName,
        history: [{ ...actor, action: 'created', meta: { quantity } }],
      });
      return { action: 'created', request: created };
    } catch (err) {
      // Гонка двох продавців одного магазину: унікальний індекс віддав перемогу
      // першому. Другий не створює дубль — він оновлює те, що вже є.
      if (err?.code !== 11000) throw err;
      const won = await SupplementRequest.findOneAndUpdate(
        { offerId: fresh._id, shopId: ctx.shopId, packed: false },
        {
          $set: { quantity, updatedBy: actor.by, updatedByName: actor.byName },
          $push: { history: { ...actor, at: new Date(), action: 'quantity_changed', meta: { to: quantity, raced: true } } },
        },
        { new: true },
      );
      if (!won) throw appError('supplement_request_locked');
      return { action: 'updated', request: won };
    }
  });

  if (action === 'noop') return res.json({ ok: true, quantity, action: 'noop' });

  // Номер коробки — ПІДКАЗКА, а не умова роботи (рішення власника 05.08.2026).
  // Якщо в групи вже є сесія з замороженими номерами, магазин дістає наступний
  // вільний у хвіст, існуючі не пересортовуються (§11). Якщо сесії ще немає або
  // номери не заморожені — просто немає номера, і склад пакує в коробку з
  // назвою магазину. Створювати сесію заради номера ми не будемо.
  //
  // AWAIT, не fire-and-forget: поки номера немає, склад бачить рядок без
  // коробки. Чекати тут — десятки мілісекунд, а фоновий виклик, який тихо впав,
  // лишив би магазин без номера назавжди (повторювача немає).
  const sessionId = await boxNumberSessionId(ctx.deliveryGroupId, ctx.groupDayOfWeek);
  if (sessionId) {
    try {
      await assignLateShopNumber(sessionId, ctx.shopId, ctx.shopName);
    } catch (err) {
      console.warn('[supplement] нумерація коробки не вдалась:', err.message);
    }
  }

  emit('supplement_request_changed', {
    offerId: String(offer._id),
    deliveryGroupId: ctx.deliveryGroupId,
    shopId: ctx.shopId,
    action,
  });
  emit('user_order_updated', { buyerTelegramId: String(user.telegramId) });

  res.json({ ok: true, quantity: request.quantity, action });
}));

/**
 * DELETE /api/supplement/:offerId/request — прибрати заявку магазину.
 * Ті самі гарди: дедлайн і жорстке блокування після packed.
 */
router.delete('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const offer = await loadOfferForSeller(req.params.offerId, ctx);

  // Скасування небезпечніше за зміну кількості: між перевіркою packed і
  // видаленням склад міг спакувати цей магазин — і заявка зникла б, поки товар
  // уже лежить у коробці. Ніхто б навіть не дізнався, що його треба вийняти.
  // Тому: замок пропозиції + packed:false у ФІЛЬТРІ самого видалення.
  const removed = await withOfferLock(offer._id, async () => {
    const fresh = await SupplementOffer.findById(offer._id, 'status');
    if (!fresh) throw appError('supplement_offer_not_found');
    if (!isOfferOpenForSellers(fresh)) throw appError('supplement_closed');

    const existing = await SupplementRequest.findOne({ offerId: offer._id, shopId: ctx.shopId }, '_id packed');
    if (!existing) return 'noop';
    if (existing.packed) throw appError('supplement_request_locked');

    const deleted = await SupplementRequest.findOneAndDelete({ _id: existing._id, packed: false });
    if (!deleted) throw appError('supplement_request_locked');
    return 'cancelled';
  });

  if (removed === 'noop') return res.json({ ok: true, action: 'noop' });

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
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString() });
  }

  // Список читається ЗА ГРУПОЮ — тим самим фільтром, що й лічильник плитки в
  // routes/picking.js. Стан сесії збирання тут ні до чого: хвиля дозамовлення
  // живе власним циклом і зникає з блока, коли закривається сама.
  const offers = await findActiveOffersForGroup(groupId);
  if (!offers.length) return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString() });

  const offerIds = offers.map((o) => o._id);
  const receiptIds = [...new Set(offers.map((offer) => String(offer.receiptId)))];
  const [productMap, requests, locations, receipts] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offerIds } }, 'offerId quantity packed').lean(),
    resolveProductLocations(offers.map((o) => o.productId)),
    Receipt.find({ _id: { $in: receiptIds } }, '_id receiptNumber').lean(),
  ]);
  const receiptNumberById = new Map(receipts.map((receipt) => [String(receipt._id), receipt.receiptNumber || '']));

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
      receiptId: String(offer.receiptId),
      receiptNumber: receiptNumberById.get(String(offer.receiptId)) || '',
      status,
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

/**
 * Спільна збірка повної картки — використовується GET і після кожної мутації.
 * `me` потрібен, щоб сервер сам сказав «товар у ТВОЇХ руках»: клієнт не знає
 * свого telegramId у цьому місці, а порівнювати замок він мусить безпомилково.
 *
 * Номери коробок беруться з поточної сесії групи, ЯКЩО вона є і вже їх заморозила.
 * Немає сесії або номерів — картка чесно показує «немає номера», і це нормальний
 * робочий стан, а не збій: пакувати можна і в коробку з назвою магазину.
 */
async function buildOfferCard(offer, me = '') {
  const group = await DeliveryGroup.findById(offer.deliveryGroupId, 'dayOfWeek').lean();
  const sessionId = group ? await boxNumberSessionId(offer.deliveryGroupId, group.dayOfWeek) : null;

  const [requests, locations, productMap, session] = await Promise.all([
    SupplementRequest.find({ offerId: offer._id }).lean(),
    resolveProductLocations([offer.productId]),
    loadProductsFor([offer]),
    sessionId ? OrderingSession.findById(sessionId, 'shopNumbers').lean() : null,
  ]);
  const lookup = buildShopNumberLookup(session?.shopNumbers);
  const view = offerViewForWarehouse(offer, {
    product: productMap.get(String(offer.productId)),
    requests,
    location: locations.get(String(offer.productId)),
    boxNumberFor: (r) => lookup.byId.get(String(r.shopId))
      ?? lookup.byName.get(String(r.shopName || ''))
      ?? null,
  });
  view.lockedByMe = !!me && String(offer.lockedBy || '') === String(me);
  return view;
}

/**
 * POST /api/supplement/receipts/:receiptId/freeze
 * Ручне закриття прийому дозамовлень для всієї накладної. Доступне складу й
 * адміну. Telegram-повідомлення про закриття свідомо НЕ надсилається.
 */
router.post('/receipts/:receiptId/freeze', warehouseRoles, asyncHandler(async (req, res) => {
  const receiptId = String(req.params.receiptId || '');
  if (!mongoose.Types.ObjectId.isValid(receiptId)) throw appError('receipt_not_found');

  const receipt = await Receipt.findById(receiptId, 'type targetDeliveryGroupId').lean();
  if (!receipt || receipt.type !== 'supplement') throw appError('receipt_not_found');

  const frozen = await freezeReceiptOffers(receiptId, actorOf(req.telegramUser));
  // frozen без заявок одразу закриваємо, щоб порожні картки не висіли до тіку.
  const { autoCompleteEmptyOffers } = require('../services/supplementOffers');
  await autoCompleteEmptyOffers(new Date());

  res.json({ ok: true, frozenCount: frozen.length });
}));

/**
 * GET /api/supplement/offers/:offerId — картка для перегляду (без захоплення).
 * Використовується поллінгом уже відкритої картки.
 */
router.get('/offers/:offerId', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(req.params.offerId).lean();
  if (!offer) throw appError('supplement_offer_not_found');
  res.json({
    offer: await buildOfferCard(offer, req.telegramUser?.telegramId),
    serverTime: new Date().toISOString(),
  });
}));

/**
 * POST /api/supplement/offers/:offerId/claim — взяти пропозицію в роботу.
 *
 * Одна пропозиція — один складник. Без цього двоє могли відкрити ту саму
 * картку, обидва побачити «Магазин №12 — 4 шт, не спаковано», обидва покласти
 * по 4 і обидва натиснути галочку: у базі один packed=true, у коробці 8 штук.
 * База такого дубля не бачить у принципі — тому не пускаємо його фізично.
 *
 * Ідемпотентно для власника (повторне відкриття = heartbeat). Прострочений
 * чужий замок (>3 хв без активності) перехоплюється автоматично.
 */
router.post('/offers/:offerId/claim', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const me = String(req.telegramUser?.telegramId || '');

  const result = await claimOffer(req.params.offerId, me);
  if (!result.ok) {
    if (result.reason === 'supplement_locked_by_other') {
      const holder = result.lockedBy
        ? await User.findOne({ telegramId: result.lockedBy }, 'firstName lastName').lean()
        : null;
      const name = holder ? [holder.firstName, holder.lastName].filter(Boolean).join(' ') : '';
      throw appError('supplement_locked_by_other', { name });
    }
    throw appError(result.reason);
  }

  const claimedDoc = result.offer.toObject ? result.offer.toObject() : result.offer;
  res.json({ offer: await buildOfferCard(claimedDoc, me), serverTime: new Date().toISOString() });
}));

/** POST /api/supplement/offers/:offerId/release — закрив картку, відпустив товар. */
router.post('/offers/:offerId/release', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  await releaseOffer(req.params.offerId, req.telegramUser?.telegramId);
  res.json({ ok: true });
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

  const head = await SupplementRequest.findById(req.params.requestId, 'offerId shopId').lean();
  if (!head) throw appError('supplement_request_not_found');

  const offer = await withOfferLock(head.offerId, async () => {
    const fresh = await SupplementOffer.findById(head.offerId).lean();
    if (!fresh) throw appError('supplement_offer_not_found');
    // Завершена пропозиція більше не приймає змін — ні від продавця, ні від складу (§21).
    if (fresh.status === 'completed') throw appError('supplement_closed');
    // Товар має бути в руках саме цього працівника — див. /claim. Прострочений
    // чужий замок перехоплюється тим самим викликом, тому це не глухий кут.
    if (String(fresh.lockedBy || '') !== String(actor.by)) {
      throw appError('supplement_not_claimed');
    }

    // Один атомарний запис у ВЛАСНИЙ документ заявки: паралельна поява нового
    // магазину не може стерти вже поставлені галочки (§22 тест 5). Фільтр за
    // поточним значенням packed робить операцію ідемпотентною — повторний тап
    // просто нічого не змінює.
    await SupplementRequest.updateOne(
      { _id: req.params.requestId, packed: !packed },
      {
        $set: {
          packed,
          packedBy: packed ? actor.by : '',
          packedByName: packed ? actor.byName : '',
          packedAt: packed ? new Date() : null,
        },
        $push: { history: { ...actor, at: new Date(), action: packed ? 'packed' : 'unpacked' } },
      },
    );
    return fresh;
  });

  const request = { _id: req.params.requestId, shopId: head.shopId };

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

  res.json({ offer: await buildOfferCard(offer, actor.by) });
}));

/**
 * POST /api/supplement/offers/:offerId/complete — «Спакував».
 * Умови перевіряє сервер (services/supplementOffers.completeOffer):
 * frozen + є заявки + усі packed. До заморозки завершити не можна (§18).
 */
router.post('/offers/:offerId/complete', warehouseRoles, asyncHandler(async (req, res) => {
  const me = String(req.telegramUser?.telegramId || '');
  // Завершує лише той, хто тримає товар у руках. Інакше колега, у якого картка
  // просто відкрита, міг би закрити пропозицію під час чужого пакування.
  const holder = await SupplementOffer.findById(req.params.offerId, 'lockedBy status').lean();
  if (!holder) throw appError('supplement_offer_not_found');
  if (holder.status !== 'completed' && String(holder.lockedBy || '') !== me) {
    throw appError('supplement_not_claimed');
  }

  try {
    await completeOffer(req.params.offerId, actorOf(req.telegramUser));
  } catch (err) {
    if (err?.code && String(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  res.json({ ok: true });
}));

module.exports = router;
