'use strict';

/**
 * Ядро «Дозамовлення» (Zlotoweczka_Dozamovlennia_Povna_spetsyfikatsiia_2026-08-05.md).
 *
 * Тут живе вся логіка, спільна для роутів, планувальника і гардів:
 *   • які групи взагалі є цільовими для пропозиції (§5);
 *   • ідемпотентне створення пропозицій після проведення накладної (§4, §21);
 *   • ЄДИНЕ джерело істини про те, чи пропозиція ще open (§21 — дедлайн
 *     перевіряється в кожній операції, а не тільки планувальником);
 *   • заморозка / авто-завершення / завершення складом;
 *   • фізичне місце товару для картки (§9).
 *
 * Свідомо ВІДСУТНЄ у першій версії (рішення власника 05.08.2026):
 *   • адміністративне скасування пропозиції (§16) і cleanup спакованих коробок;
 *   • OOS / часткове виконання / архівування з віртуального блока (§14).
 * TODO на майбутнє (§24): облік залишку та резервування, розподіл при нестачі.
 */

const mongoose = require('mongoose');

const DeliveryGroup     = require('../models/DeliveryGroup');
const OrderingSession   = require('../models/OrderingSession');
const Block             = require('../models/Block');
const Product           = require('../models/Product');
const ReceiptItem       = require('../models/ReceiptItem');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { getProductTitle } = require('./archiveProduct');
const { getIO } = require('../socket');

// ─── Статус ──────────────────────────────────────────────────────────────────

/**
 * Реальний статус пропозиції ЗАРАЗ.
 *
 * Планувальник переводить open → frozen раз на кілька секунд, тому між моментом
 * closesAt і його тіком у базі ще лежить 'open'. Якби продавець і склад читали
 * сирий status, у цьому вікні продавець ще міг би змінити заявку, а склад уже
 * бачив би кнопку «Спакував» — два різні стани одночасно (§22, тест 8).
 * Усі перевірки йдуть через цю функцію, тож рішення завжди приймає СЕРВЕРНИЙ
 * час, а не те, чи встиг спрацювати таймер.
 */
function effectiveOfferStatus(offer, now = new Date()) {
  if (!offer) return null;
  if (offer.status !== 'open') return offer.status;
  return new Date(offer.closesAt).getTime() <= now.getTime() ? 'frozen' : 'open';
}

/** Пропозиція ще приймає зміни від продавців? */
function isOfferOpenForSellers(offer, now = new Date()) {
  return effectiveOfferStatus(offer, now) === 'open';
}

// Одне визначення «активної» пропозиції для сервісу, роутів і гарда завершення
// сесії — живе на моделі (див. models/SupplementOffer.js).
const ACTIVE_STATUSES = SupplementOffer.ACTIVE_STATUSES;

// ─── Цільові групи (§5) ──────────────────────────────────────────────────────

/**
 * Групи, яким ЗАРАЗ можна відкрити дозамовлення:
 *   1. звичайне вікно замовлень уже закрите — інакше товар просто потрапить у
 *      звичайний каталог, і окремий канал не потрібен;
 *   2. сесія цієї групи існує і НЕ completed (§5, критичне правило) — у
 *      завершену доставку дозамовляти нічого.
 *
 * Сесія резолвиться тим самим getOrCreateSessionId, що й скрізь у системі, тож
 * ідентичність (groupId + openDate) збігається з рештою кодової бази. Для групи,
 * чия доставка вже давно проїхала, ця функція поверне ЇЇ ж сесію — і та буде
 * completed, тому група відсіється.
 */
async function resolveTargetSessions() {
  const schedule = await getOrderingSchedule();
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek').lean();

  const targets = [];
  for (const group of groups) {
    if (!Number.isInteger(group.dayOfWeek)) continue;
    if (isOrderingOpen(group.dayOfWeek, schedule).isOpen) continue;

    const orderingSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);
    const session = await OrderingSession.findById(orderingSessionId, 'pickingStatus').lean();
    if (!session || session.pickingStatus === 'completed') continue;

    targets.push({
      deliveryGroupId: String(group._id),
      groupName: group.name || '',
      dayOfWeek: group.dayOfWeek,
      orderingSessionId,
    });
  }
  return targets;
}

// ─── Створення після проведення накладної (§4) ───────────────────────────────

/**
 * Створює пропозиції для всіх позицій накладної з галочкою «Дозамовлення».
 *
 * ІДЕМПОТЕНТНО (§21, §22 тест 2): унікальний індекс {receiptItemId, deliveryGroupId}
 * + insertMany({ordered:false}) означає, що повторний виклик (ретрай, друге
 * натискання «Провести») просто не вставить нічого нового — дублікати ловляться
 * як E11000 і мовчки пропускаються. Тому цей крок безпечно винесений ПІСЛЯ
 * транзакції проведення: він не може лишитися «напіввиконаним» у сенсі, що щось
 * доведеться відкочувати.
 *
 * КРИТИЧНЕ ПРАВИЛО (§4): позиція з destination='shops' НІКОЛИ не створює
 * пропозицію, навіть якщо прапорець якимось чином лишився true. Перевірка
 * дублюється тут, бо роут — не єдиний шлях у базу.
 *
 * @returns {Promise<Array>} щойно СТВОРЕНІ пропозиції (для розсилки).
 */
async function createOffersForReceipt(receiptId) {
  const items = await ReceiptItem.find(
    { receiptId, supplementOffer: true },
    '_id destination createdProductId existingProductId name',
  ).lean();

  const eligible = items.filter(
    (i) => (i.destination || 'shelf') !== 'shops' && (i.createdProductId || i.existingProductId),
  );
  if (!eligible.length) return [];

  const targets = await resolveTargetSessions();
  if (!targets.length) {
    console.log('[supplement] накладна', String(receiptId), '— немає цільових груп (усі вікна відкриті або сесії завершені)');
    return [];
  }

  const { windowMinutes } = await getSupplementSettings();
  const openedAt = new Date();
  // Дедлайн фіксується ОДИН раз, на всю хвилю цієї накладної (§6). Пізніша
  // накладна отримає власний, пізніший closesAt.
  const closesAt = new Date(openedAt.getTime() + windowMinutes * 60 * 1000);

  const docs = [];
  for (const item of eligible) {
    const productId = item.createdProductId || item.existingProductId;
    for (const t of targets) {
      docs.push({
        receiptId,
        receiptItemId: item._id,
        productId,
        deliveryGroupId: t.deliveryGroupId,
        orderingSessionId: t.orderingSessionId,
        openedAt,
        closesAt,
        status: 'open',
      });
    }
  }

  // Вставляємо по одному, а не insertMany({ordered:false}): документів одиниці
  // (позиції × групи), зате видно ТОЧНО, що створилось, а що впало дублікатом.
  // Розбирати часткову помилку bulk-write заради цього не варто — саме зі списку
  // створених іде Telegram-розсилка, і помилитися тут означає або спамити двічі,
  // або промовчати зовсім.
  const created = [];
  let duplicates = 0;
  for (const doc of docs) {
    try {
      created.push(await SupplementOffer.create(doc));
    } catch (err) {
      if (err?.code === 11000) { duplicates += 1; continue; }
      throw err;
    }
  }
  if (duplicates) {
    console.log(`[supplement] накладна ${String(receiptId)}: ${duplicates} пропозицій уже існували — пропущено`);
  }

  return created;
}

// ─── Фізичне місце товару (§9) ───────────────────────────────────────────────

/**
 * Де товар лежить ЗАРАЗ: у звичайному блоці чи ще в «Надходженнях».
 * Віртуальний блок описує ТИП роботи, а не адресу, тому картка має показувати
 * справжнє місце і оновлювати його, коли склад розкладає товар по полицях.
 *
 * @returns {Promise<Map<string, {blockId:number, positionIndex:number}|null>>}
 */
async function resolveProductLocations(productIds = []) {
  const ids = [...new Set(productIds.map(String))].filter(Boolean);
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return out;

  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!objectIds.length) return out;

  const blocks = await Block.find({ productIds: { $in: objectIds } }, 'blockId productIds').lean();
  for (const block of blocks) {
    (block.productIds || []).forEach((pid, index) => {
      const key = String(pid);
      if (!out.has(key)) return;
      // positionIndex — 1-based, як у PickingTask (services/taskBuilder.js).
      out.set(key, { blockId: block.blockId, positionIndex: index + 1 });
    });
  }
  return out;
}

function formatLocation(location) {
  if (!location) return 'Надходження';
  return `Блок ${location.blockId}, позиція ${location.positionIndex}`;
}

// ─── Збірка відповіді API ────────────────────────────────────────────────────

function productView(product) {
  if (!product) return { productId: null, title: 'Товар недоступний', imageUrl: null, price: 0 };
  return {
    productId: String(product._id),
    title: getProductTitle(product),
    imageUrl: (Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl || null,
    price: Number(product.price || 0),
    aiDescription: product.aiDescription || '',
  };
}

/**
 * Картка пропозиції для складу: товар + фізичне місце + повний список магазинів.
 * `requests` уже відсортовані викликачем за номером коробки.
 */
function offerViewForWarehouse(offer, { product, requests = [], location = null, boxNumberFor = () => null, now = new Date() }) {
  const status = effectiveOfferStatus(offer, now);
  const rows = requests.map((r) => ({
    requestId: String(r._id),
    shopId: String(r.shopId),
    shopName: r.shopName || '',
    shopNumber: boxNumberFor(r),
    quantity: r.quantity,
    packed: !!r.packed,
    packedByName: r.packedByName || '',
    packedAt: r.packedAt || null,
  }));
  rows.sort((a, b) => (a.shopNumber ?? Infinity) - (b.shopNumber ?? Infinity)
    || String(a.shopName).localeCompare(String(b.shopName), 'uk'));

  return {
    offerId: String(offer._id),
    status,
    openedAt: offer.openedAt,
    closesAt: offer.closesAt,
    deliveryGroupId: String(offer.deliveryGroupId),
    orderingSessionId: String(offer.orderingSessionId),
    product: productView(product),
    location: location ? { ...location, label: formatLocation(location) } : { blockId: null, positionIndex: null, label: formatLocation(null) },
    shops: rows,
    totalQty: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
    packedCount: rows.filter((r) => r.packed).length,
    // Сервер сам каже, чи можна завершувати — клієнт не має відтворювати правило.
    canComplete: status === 'frozen' && rows.length > 0 && rows.every((r) => r.packed),
  };
}

// ─── Переходи статусів ───────────────────────────────────────────────────────

function emit(event, payload) {
  try {
    const io = getIO();
    if (io) io.emit(event, payload);
  } catch { /* сокет може бути вимкнений у тестах */ }
}

/**
 * Дозамовлення блокує завершення сесії (§17), тому закриття ОСТАННЬОЇ пропозиції
 * саме по собі може бути тим, чого сесії бракувало. Без цього поштовху сесія, у
 * якої всі звичайні задачі вже зібрані, лишалась би in_progress назавжди:
 * maybeCompleteSession викликається лише після завершення PickingTask, а їх
 * більше не буде.
 *
 * Лінивий require: utils/sessionStatus читає модель SupplementOffer для гарда,
 * і статичний імпорт в обидва боки був би циклом.
 */
async function nudgeSessionCompletion(orderingSessionId) {
  if (!orderingSessionId) return;
  try {
    const { maybeCompleteSession } = require('../utils/sessionStatus');
    await maybeCompleteSession(orderingSessionId, { meta: { reason: 'supplement_closed' } });
  } catch (err) {
    console.warn('[supplement] спроба завершити сесію не вдалась:', err?.message);
  }
}

/**
 * Заморозити всі пропозиції, дедлайн яких минув. CAS-фільтр status:'open'
 * гарантує, що два воркери не заморозять одну пропозицію двічі.
 * @returns {Promise<Array>} щойно заморожені пропозиції.
 */
async function freezeDueOffers(now = new Date()) {
  const due = await SupplementOffer.find(
    { status: 'open', closesAt: { $lte: now } },
    '_id deliveryGroupId orderingSessionId productId closesAt notifiedTypes',
  ).lean();

  const frozen = [];
  for (const o of due) {
    const updated = await SupplementOffer.findOneAndUpdate(
      { _id: o._id, status: 'open' },
      { $set: { status: 'frozen', frozenAt: now } },
      { new: true },
    );
    if (updated) frozen.push(updated);
  }

  for (const o of frozen) {
    emit('supplement_frozen', {
      offerId: String(o._id),
      deliveryGroupId: String(o.deliveryGroupId),
      orderingSessionId: String(o.orderingSessionId),
    });
  }
  return frozen;
}

/**
 * Пропозиція, яку ніхто не замовив, після дедлайну закривається сама і зникає з
 * віртуального блока — складу нема чого робити (§7, §22 тест 10).
 * @returns {Promise<number>} скільки закрито.
 */
async function autoCompleteEmptyOffers(now = new Date()) {
  const frozen = await SupplementOffer.find(
    { status: 'frozen' },
    '_id deliveryGroupId orderingSessionId',
  ).lean();

  let closed = 0;
  for (const o of frozen) {
    const hasRequests = await SupplementRequest.exists({ offerId: o._id });
    if (hasRequests) continue;
    const updated = await SupplementOffer.findOneAndUpdate(
      { _id: o._id, status: 'frozen' },
      { $set: { status: 'completed', completedAt: now } },
      { new: true },
    );
    if (!updated) continue;
    closed += 1;
    emit('supplement_completed', {
      offerId: String(o._id),
      deliveryGroupId: String(o.deliveryGroupId),
      orderingSessionId: String(o.orderingSessionId),
      reason: 'empty',
    });
    await nudgeSessionCompletion(o.orderingSessionId);
  }
  return closed;
}

/**
 * «Спакував» — фінальне закриття пропозиції складом.
 *
 * Усі умови перевіряються СЕРВЕРОМ (§21):
 *   • пропозиція існує і ще не completed;
 *   • ефективний статус = frozen (до дедлайну завершувати не можна, §18);
 *   • кожна заявка магазину позначена packed.
 *
 * @throws {Error} з .code: supplement_offer_not_found | supplement_not_frozen |
 *                          supplement_not_all_packed | supplement_no_requests
 */
async function completeOffer(offerId, actor = {}, now = new Date()) {
  const offer = await SupplementOffer.findById(offerId);
  if (!offer) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
  if (offer.status === 'completed') return offer; // ідемпотентно

  if (effectiveOfferStatus(offer, now) !== 'frozen') {
    throw Object.assign(new Error('offer not frozen'), { code: 'supplement_not_frozen' });
  }

  const requests = await SupplementRequest.find({ offerId: offer._id }, 'packed').lean();
  if (!requests.length) throw Object.assign(new Error('no requests'), { code: 'supplement_no_requests' });
  if (requests.some((r) => !r.packed)) {
    throw Object.assign(new Error('not all packed'), { code: 'supplement_not_all_packed' });
  }

  // Фільтр за $ne:'completed' — щоб два одночасні натискання не переписали
  // completedBy. Статус ще міг бути 'open' (дедлайн минув, планувальник не
  // встиг) — обидва варіанти допустимі, бо ефективний статус уже перевірено.
  const updated = await SupplementOffer.findOneAndUpdate(
    { _id: offer._id, status: { $ne: 'completed' } },
    {
      $set: {
        status: 'completed',
        completedAt: now,
        frozenAt: offer.frozenAt || now,
        completedBy: String(actor.by || ''),
        completedByName: String(actor.byName || ''),
      },
    },
    { new: true },
  );

  emit('supplement_completed', {
    offerId: String(offer._id),
    deliveryGroupId: String(offer.deliveryGroupId),
    orderingSessionId: String(offer.orderingSessionId),
    reason: 'packed',
  });
  await nudgeSessionCompletion(offer.orderingSessionId);

  return updated || offer;
}

// ─── Гарди / лічильники ──────────────────────────────────────────────────────

/**
 * Чи є в сесії пропозиції, які ще не доведені до кінця (§17)?
 * Використовується гардом завершення сесії — сесію не можна закрити, поки
 * дозамовлення відкрите або заморожене й неспаковане.
 */
async function countActiveOffersForSession(orderingSessionId, mongoSession = null) {
  if (!orderingSessionId) return 0;
  const query = SupplementOffer.countDocuments({
    orderingSessionId: String(orderingSessionId),
    status: { $in: ACTIVE_STATUSES },
  });
  if (mongoSession) query.session(mongoSession);
  return query;
}

/** Активні пропозиції групи — для віртуального блока складу (§8). */
async function findActiveOffersForGroup(deliveryGroupId) {
  return SupplementOffer.find({
    deliveryGroupId: String(deliveryGroupId),
    status: { $in: ACTIVE_STATUSES },
  }).sort({ closesAt: 1, createdAt: 1 }).lean();
}

/** Товари пропозицій одним запитом (картки і каталог продавця). */
async function loadProductsFor(offers = []) {
  const ids = [...new Set(offers.map((o) => String(o.productId)))];
  if (!ids.length) return new Map();
  const products = await Product.find(
    { _id: { $in: ids } },
    '_id name brand model category warehouse orderNumber price imageUrls localImageUrl aiDescription',
  ).lean();
  return new Map(products.map((p) => [String(p._id), p]));
}

module.exports = {
  ACTIVE_STATUSES,
  effectiveOfferStatus,
  isOfferOpenForSellers,
  resolveTargetSessions,
  createOffersForReceipt,
  resolveProductLocations,
  formatLocation,
  productView,
  offerViewForWarehouse,
  freezeDueOffers,
  autoCompleteEmptyOffers,
  completeOffer,
  countActiveOffersForSession,
  findActiveOffersForGroup,
  loadProductsFor,
};
