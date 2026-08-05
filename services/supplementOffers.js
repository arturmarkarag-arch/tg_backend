'use strict';

// Актуальна бізнес-логіка: docs/supplement/readme.md

const mongoose = require('mongoose');

const Block             = require('../models/Block');
const Product           = require('../models/Product');
const ReceiptItem       = require('../models/ReceiptItem');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');

const Receipt = require('../models/Receipt');

const { withLock } = require('../utils/lock');
const { getProductTitle } = require('./archiveProduct');
const { getIO } = require('../socket');

// ─── Статус ──────────────────────────────────────────────────────────────────

/** Поточний збережений статус пропозиції. */
function effectiveOfferStatus(offer) {
  if (!offer) return null;
  return offer.status;
}

/** Пропозиція ще приймає зміни від продавців? */
function isOfferOpenForSellers(offer, now = new Date()) {
  return effectiveOfferStatus(offer, now) === 'open';
}

// Спільне визначення активної пропозиції.
const ACTIVE_STATUSES = SupplementOffer.ACTIVE_STATUSES;

// Створення пропозицій після проведення: docs/receipt/readme.md#2-проведення-накладної-дозамовлення
/** @returns {Promise<{created: Array, complete: boolean}>} */
async function createOffersForReceipt(receiptId) {
  const receipt = await Receipt.findById(
    receiptId,
    'type targetDeliveryGroupId supplementOpenedAt receiptNumber',
  ).lean();
  if (!receipt) return { created: [], complete: true };

  // Звичайна накладна не створює дозамовлення.
  if (receipt.type !== 'supplement') {
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: null } });
    return { created: [], complete: true };
  }

  // Проведена накладна-дозамовлення повинна мати цільову групу.
  if (!receipt.targetDeliveryGroupId) {
    console.error('[supplement] накладна', receipt.receiptNumber, '— тип supplement без цільової групи; пропозиції не створюються');
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'ready' } });
    return { created: [], complete: true };
  }

  const items = await ReceiptItem.find(
    { receiptId },
    '_id destination createdProductId existingProductId name',
  ).lean();

  const eligible = items.filter(
    (i) => (i.destination || 'shelf') !== 'shops' && (i.createdProductId || i.existingProductId),
  );
  if (!eligible.length) {
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'ready' } });
    return { created: [], complete: true };
  }

  // Усередині однієї накладної однаковий товар показується один раз.
  const byProduct = new Map();
  for (const item of eligible) {
    const productId = String(item.createdProductId || item.existingProductId);
    if (!byProduct.has(productId)) byProduct.set(productId, item);
  }

  // Закриття виконується вручну, тому дедлайну немає.
  const openedAt = receipt.supplementOpenedAt ? new Date(receipt.supplementOpenedAt) : new Date();

  const deliveryGroupId = String(receipt.targetDeliveryGroupId);

  const docs = [];
  for (const [productId, item] of byProduct) {
    docs.push({
      receiptId,
      receiptItemId: item._id,
      productId,
      deliveryGroupId,
      openedAt,
      closesAt: null,
      status: 'open',
      lastReminderAt: openedAt,
    });
  }

  // Окремі помилки не зупиняють решту вставок; pending добиває звірятель.
  const created = [];
  let duplicates = 0;
  let failed = 0;
  for (const doc of docs) {
    try {
      created.push(await SupplementOffer.create(doc));
    } catch (err) {
      if (err?.code === 11000) { duplicates += 1; continue; }
      failed += 1;
      console.error('[supplement] не вдалося створити пропозицію', doc.productId, '→', doc.deliveryGroupId, ':', err?.message);
    }
  }
  if (duplicates) {
    console.log(`[supplement] накладна ${String(receiptId)}: ${duplicates} пропозицій уже існували — пропущено`);
  }

  const complete = failed === 0;
  await Receipt.updateOne(
    { _id: receiptId },
    { $set: { supplementStatus: complete ? 'ready' : 'pending' } },
  );
  if (!complete) {
    console.error(`[supplement] накладна ${String(receiptId)}: ${failed} пропозицій НЕ створено — позначено на повтор`);
  }

  return { created, complete };
}

/** Доводить до кінця проведені накладні зі supplementStatus='pending'. */
async function reconcilePendingReceipts() {
  const stuck = await Receipt.find({ supplementStatus: 'pending' }, '_id receiptNumber').limit(20).lean();
  if (!stuck.length) return 0;

  let repaired = 0;
  for (const receipt of stuck) {
    try {
      const { created, complete } = await createOffersForReceipt(receipt._id);
      if (created.length) {
        // Розсилка йде тим самим шляхом, що й у звичайному відкритті.
        const { notifyOffers } = require('./supplementNotify');
        notifyOffers(created, 'opened').catch((e) =>
          console.error('[supplement] розсилка після довідновлення впала:', e?.message));
        for (const offer of created) {
          emit('supplement_opened', {
            offerId: String(offer._id),
            deliveryGroupId: String(offer.deliveryGroupId),
            closesAt: offer.closesAt,
          });
        }
      }
      if (complete) repaired += 1;
      console.log(`[supplement] довідновлено накладну ${receipt.receiptNumber}: +${created.length} пропозицій`);
    } catch (err) {
      console.error('[supplement] довідновлення накладної', receipt.receiptNumber, 'впало:', err?.message);
    }
  }
  return repaired;
}

// Фізичне місце товару: docs/supplement/readme.md#5-віртуальний-блок

/** @returns {Promise<Map<string, {blockId:number, positionIndex:number}|null>>} */
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
    // null означає, що номер коробки ще не призначено; пакування це не блокує.
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
    product: productView(product),
    location: location ? { ...location, label: formatLocation(location) } : { blockId: null, positionIndex: null, label: formatLocation(null) },
    shops: rows,
    totalQty: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
    packedCount: rows.filter((r) => r.packed).length,
    // Хто тримає пропозицію в руках. Клієнт вирішує за цим, показати картку в
    // роботі чи «зайнято колегою».
    lockedBy: offer.lockedBy ? String(offer.lockedBy) : null,
    lockedAt: offer.lockedAt || null,
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

// ─── Серіалізація операцій над однією пропозицією ────────────────────────────

/** Серіалізує зміни однієї пропозиції між продавцем і складом. */
function withOfferLock(offerId, fn) {
  return withLock(`supplement:${String(offerId)}`, fn, { ttlMs: 10_000, waitMs: 5_000 });
}

// Скільки пропозиція може «висіти» за складником, який пішов і не закрив картку.
// Той самий поріг, що й для перехоплення звичайної задачі (pickingService).
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;

/** Взяти пропозицію в роботу. @returns {{ ok: boolean, offer?: object, lockedBy?: string }} */
async function claimOffer(offerId, telegramId, now = new Date()) {
  const me = String(telegramId || '');
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  const claimed = await SupplementOffer.findOneAndUpdate(
    {
      _id: offerId,
      status: { $in: ACTIVE_STATUSES },
      $or: [
        { lockedBy: null },
        { lockedBy: me },
        { lockedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { lockedBy: me, lockedAt: now } },
    { new: true },
  );
  if (claimed) return { ok: true, offer: claimed };

  const existing = await SupplementOffer.findById(offerId, 'lockedBy status').lean();
  if (!existing) return { ok: false, reason: 'supplement_offer_not_found' };
  if (existing.status === 'completed') return { ok: false, reason: 'supplement_closed' };
  return { ok: false, reason: 'supplement_locked_by_other', lockedBy: String(existing.lockedBy || '') };
}

/** Відпустити пропозицію (закрили картку). Тільки власник — чужий замок не чіпаємо. */
async function releaseOffer(offerId, telegramId) {
  await SupplementOffer.updateOne(
    { _id: offerId, lockedBy: String(telegramId || '') },
    { $set: { lockedBy: null, lockedAt: null } },
  );
}

/** Ручне закриття прийому для всіх відкритих пропозицій накладної. */
async function freezeReceiptOffers(receiptId, actor = {}, now = new Date()) {
  if (!mongoose.Types.ObjectId.isValid(String(receiptId || ''))) {
    throw Object.assign(new Error('receipt not found'), { code: 'receipt_not_found' });
  }

  const open = await SupplementOffer.find({ receiptId, status: 'open' }, '_id deliveryGroupId').lean();
  const frozen = [];
  for (const o of open) {
    const updated = await withOfferLock(o._id, () => SupplementOffer.findOneAndUpdate(
      { _id: o._id, status: 'open' },
      {
        $set: {
          status: 'frozen',
          frozenAt: now,
          frozenBy: String(actor.by || ''),
          frozenByName: String(actor.byName || ''),
        },
      },
      { new: true },
    ));
    if (updated) frozen.push(updated);
  }

  for (const o of frozen) {
    emit('supplement_frozen', {
      offerId: String(o._id),
      receiptId: String(receiptId),
      deliveryGroupId: String(o.deliveryGroupId),
    });
  }
  return frozen;
}

/** Після ручного frozen автоматично закриває пропозиції без заявок. */
async function autoCompleteEmptyOffers(now = new Date()) {
  const frozen = await SupplementOffer.find(
    { status: 'frozen' },
    '_id deliveryGroupId',
  ).lean();

  let closed = 0;
  for (const o of frozen) {
    // Перевірка й закриття виконуються під одним offer-lock.
    const updated = await withOfferLock(o._id, async () => {
      if (await SupplementRequest.exists({ offerId: o._id })) return null;
      return SupplementOffer.findOneAndUpdate(
        { _id: o._id, status: 'frozen' },
        { $set: { status: 'completed', completedAt: now, lockedBy: null, lockedAt: null } },
        { new: true },
      );
    });
    if (!updated) continue;
    closed += 1;
    emit('supplement_completed', {
      offerId: String(o._id),
      deliveryGroupId: String(o.deliveryGroupId),
      reason: 'empty',
    });
  }
  return closed;
}

/** Завершує frozen-пропозицію, якщо всі заявки packed. */
async function completeOffer(offerId, actor = {}, now = new Date()) {
  // Перевірка й завершення виконуються під одним offer-lock.
  const offer = await withOfferLock(offerId, async () => {
    const doc = await SupplementOffer.findById(offerId);
    if (!doc) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
    if (doc.status === 'completed') return doc; // ідемпотентно

    if (doc.status !== 'frozen') {
      throw Object.assign(new Error('offer not frozen'), { code: 'supplement_not_frozen' });
    }

    const requests = await SupplementRequest.find({ offerId: doc._id }, 'packed').lean();
    if (!requests.length) throw Object.assign(new Error('no requests'), { code: 'supplement_no_requests' });
    if (requests.some((r) => !r.packed)) {
      throw Object.assign(new Error('not all packed'), { code: 'supplement_not_all_packed' });
    }

    // Завершена пропозиція більше не потребує lock.
    return SupplementOffer.findOneAndUpdate(
      { _id: doc._id, status: { $ne: 'completed' } },
      {
        $set: {
          status: 'completed',
          completedAt: now,
          frozenAt: doc.frozenAt || now,
          completedBy: String(actor.by || ''),
          completedByName: String(actor.byName || ''),
          lockedBy: null,
          lockedAt: null,
        },
      },
      { new: true },
    ) || doc;
  });

  emit('supplement_completed', {
    offerId: String(offer._id),
    deliveryGroupId: String(offer.deliveryGroupId),
    reason: 'packed',
  });

  return offer;
}

// ─── Лічильники / вибірки ────────────────────────────────────────────────────

/**
 * Скільки хвиль групи ще в роботі — лічильник плитки віртуального блока
 * (routes/picking.js). Best-effort: підрахунок не має ламати екран збирання.
 */
async function countActiveOffersForGroup(deliveryGroupId) {
  if (!deliveryGroupId) return 0;
  try {
    return await SupplementOffer.countDocuments({
      deliveryGroupId: String(deliveryGroupId),
      status: { $in: ACTIVE_STATUSES },
    });
  } catch (err) {
    console.warn('[supplement] підрахунок дозамовлень не вдався:', err?.message);
    return 0;
  }
}

/** Активні пропозиції групи для віртуального блока. */
async function findActiveOffersForGroup(deliveryGroupId) {
  if (!deliveryGroupId) return [];
  return SupplementOffer.find({
    deliveryGroupId: String(deliveryGroupId),
    status: { $in: ACTIVE_STATUSES },
  }).sort({ createdAt: 1 }).lean();
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
  LOCK_TIMEOUT_MS,
  effectiveOfferStatus,
  isOfferOpenForSellers,
  createOffersForReceipt,
  reconcilePendingReceipts,
  resolveProductLocations,
  formatLocation,
  productView,
  offerViewForWarehouse,
  withOfferLock,
  claimOffer,
  releaseOffer,
  freezeReceiptOffers,
  autoCompleteEmptyOffers,
  completeOffer,
  countActiveOffersForGroup,
  findActiveOffersForGroup,
  loadProductsFor,
};
