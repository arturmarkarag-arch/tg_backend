'use strict';

// Актуальна бізнес-логіка: docs/supplement/readme.md

const mongoose = require('mongoose');

const Block             = require('../models/Block');
const Product           = require('../models/Product');
const ReceiptItem       = require('../models/ReceiptItem');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const SupplementWave    = require('../models/SupplementWave');
const DeliveryGroup     = require('../models/DeliveryGroup');

const Receipt = require('../models/Receipt');

const { withLock } = require('../utils/lock');
const { getProductTitle } = require('./archiveProduct');
const { getIO } = require('../socket');
const { normalizeReceiptItemRouting } = require('../utils/receiptRouting');
const { ITEM_STATUS, ITEM_RELATION_STATUS, REQUEST_STATUS, ACTIVE_ITEM_STATUSES, revisionOf, isSellerEditable, isPackable } = require('../utils/supplementState');
const { resolveSupplementTarget } = require('./supplementTargets');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const {
  effectiveOfferStatus: effectiveWaveItemStatus,
  loadWaveForOffer,
  recomputeWaveCompletion,
} = require('./supplementWaveService');

// ─── Статус ──────────────────────────────────────────────────────────────────

/** Поточний збережений статус пропозиції. */
function effectiveOfferStatus(offer) {
  if (!offer) return null;
  // V48.S3: lifecycle belongs to the current item revision. Wave status is only
  // a container summary and must never lock/unlock unrelated items.
  return offer.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN ? ITEM_STATUS.CANCELLED : offer.status;
}

/** Пропозиція ще приймає зміни від продавців? */
function isOfferOpenForSellers(offer, now = new Date()) {
  return isSellerEditable(offer);
}

// Спільне визначення активної пропозиції.
const ACTIVE_STATUSES = ACTIVE_ITEM_STATUSES; // same lifecycle vocabulary for legacy rows

// Створення пропозицій після проведення: docs/receipt/readme.md#2-проведення-накладної-дозамовлення
/** @returns {Promise<{created: Array, complete: boolean}>} */
async function createOffersForReceipt(receiptId) {
  const receipt = await Receipt.findById(
    receiptId,
    'type targetDeliveryGroupId supplementOpenedAt receiptNumber status',
  ).lean();
  if (!receipt) return { created: [], complete: true };

  const items = await ReceiptItem.find(
    { receiptId },
    '_id destination routing routingVersion createdProductId name status supplementBatchVersion supplementPublishRequestedAt',
  ).lean();

  // Legacy supplement receipt = one receipt-level group. New regular receipts
  // may mix ordinary / mandatory / supplement items, each supplement item carrying
  // its own group. No destructive migration is required.
  const candidates = [];
  let deferred = 0;
  if (receipt.type === 'supplement') {
    if (!receipt.targetDeliveryGroupId) {
      await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'ready' } });
      return { created: [], complete: true };
    }
    for (const item of items) {
      if (!item.createdProductId) continue;
      candidates.push({
        item,
        productId: String(item.createdProductId),
        deliveryGroupId: String(receipt.targetDeliveryGroupId),
      });
    }
  } else {
    for (const item of items) {
      const routing = normalizeReceiptItemRouting(item, receipt);
      if (!routing.supplement || !item.createdProductId || !routing.supplementDeliveryGroupId) continue;
      if (item.status !== 'confirmed') continue;

      // V48.S2: every modern batch row (version >= 1) is published only by the
      // explicit SupplementWave command. Receipt reconciliation must never create
      // per-item lifecycle roots behind that aggregate. Version 0 remains legacy.
      if (Number(item.supplementBatchVersion || 0) >= 1) continue;

      const target = await resolveSupplementTarget(routing.supplementDeliveryGroupId);
      candidates.push({
        item,
        productId: String(item.createdProductId),
        deliveryGroupId: String(target.deliveryGroupId),
      });
    }
  }

  if (!candidates.length) {
    // A current per-item supplement may be prepared while ordinary ordering is
    // still open. Keep the receipt pending; the minute scheduler will retry and
    // open the offer after that group's ordinary window closes. No employee has
    // to come back just to click the same route again.
    if (deferred > 0) {
      await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'pending' } });
      return { created: [], complete: false, deferred };
    }

    // Ordinary receipts with no supplement items don't need a supplement status.
    await Receipt.updateOne(
      { _id: receiptId },
      { $set: { supplementStatus: receipt.type === 'supplement' ? 'ready' : null } },
    );
    return { created: [], complete: true, deferred: 0 };
  }

  const openedAt = receipt.supplementOpenedAt ? new Date(receipt.supplementOpenedAt) : new Date();

  // One offer per receipt item + group (the model's unique index is the final
  // idempotency guard). Do not dedupe across different items unless they literally
  // share the same receiptItemId; each photographed receiving row is auditable.
  const docs = candidates.map(({ item, productId, deliveryGroupId }) => ({
    receiptId,
    receiptItemId: item._id,
    productId,
    deliveryGroupId,
    openedAt,
    closesAt: null,
    status: ITEM_STATUS.OPEN,
    lastReminderAt: openedAt,
  }));

  const created = [];
  let duplicates = 0;
  let failed = 0;
  for (const doc of docs) {
    try {
      created.push(await SupplementOffer.create(doc));
    } catch (err) {
      if (err?.code === 11000) { duplicates += 1; continue; }
      failed += 1;
    }
  }

  const complete = failed === 0 && deferred === 0;
  await Receipt.updateOne(
    { _id: receiptId },
    { $set: { supplementStatus: complete ? 'ready' : 'pending' } },
  );

  return { created, complete, deferred };
}

/** Доводить до кінця проведені накладні зі supplementStatus='pending'. */
async function reconcilePendingReceipts() {
  const stuck = await Receipt.find({ supplementStatus: 'pending' }, '_id receiptNumber').limit(500).lean();
  if (!stuck.length) return 0;

  let repaired = 0;
  for (const receipt of stuck) {
    try {
      const { created, complete } = await createOffersForReceipt(receipt._id);
      if (created.length) {
        for (const offer of created) {
          emit('supplement_opened', {
            offerId: String(offer._id),
            deliveryGroupId: String(offer.deliveryGroupId),
            closesAt: offer.closesAt,
          });
        }
      }
      if (complete) repaired += 1;
    } catch (err) {
    }
  }

  // Do NOT send Telegram here. supplementScheduler calls findDueReminders()
  // immediately after reconciliation and receives *all* open/unnotified offers
  // in one query. That is the batching boundary: even when one publication wave
  // spans several receipts (or retries a partially-created batch), all products
  // of the same delivery group are claimed and announced in ONE message.
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

function productView(product, offer = null) {
  // A modern publication keeps a revision snapshot. Explicit canonical metadata
  // corrections update the CURRENT OPEN/FROZEN revision in-place because it is the
  // same product; terminal revisions remain immutable history. A restart captures a
  // fresh ReceiptItem snapshot for the new revision.
  if (offer?.waveId && offer?.sourceSnapshot) {
    const snap = offer.sourceSnapshot || {};
    return {
      productId: product?._id ? String(product._id) : (offer?.productId ? String(offer.productId) : null),
      receiptItemId: offer?.receiptItemId ? String(offer.receiptItemId) : null,
      title: snap.title || (product ? getProductTitle(product) : 'Товар'),
      imageUrl: snap.imageUrl || null,
      price: Number(snap.price || 0),
      quantityPerPackage: Number(snap.quantityPerPackage || 0),
      aiDescription: snap.aiDescription || '',
      standaloneSupplement: !product,
    };
  }
  if (!product) {
    const snap = offer?.sourceSnapshot || {};
    return {
      productId: null,
      receiptItemId: offer?.receiptItemId ? String(offer.receiptItemId) : null,
      title: snap.title || 'Товар',
      imageUrl: snap.imageUrl || null,
      price: Number(snap.price || 0),
      quantityPerPackage: Number(snap.quantityPerPackage || 0),
      aiDescription: snap.aiDescription || '',
      standaloneSupplement: true,
    };
  }
  return {
    productId: String(product._id),
    title: getProductTitle(product),
    imageUrl: (Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl || null,
    price: Number(product.price || 0),
    quantityPerPackage: Number(product.quantityPerPackage || 0),
    aiDescription: product.aiDescription || '',
    standaloneSupplement: false,
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
    revision: revisionOf(offer),
    status,
    openedAt: offer.openedAt,
    closesAt: offer.closesAt,
    deliveryGroupId: String(offer.deliveryGroupId),
    product: productView(product, offer),
    location: location ? { ...location, label: formatLocation(location) } : { blockId: null, positionIndex: null, label: formatLocation(null) },
    shops: rows,
    totalQty: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
    packedCount: rows.filter((r) => r.packed).length,
    // Хто тримає пропозицію в руках. Клієнт вирішує за цим, показати картку в
    // роботі чи «зайнято колегою».
    lockedBy: offer.lockedBy ? String(offer.lockedBy) : null,
    lockedAt: offer.lockedAt || null,
    // Сервер сам каже, чи можна завершувати — клієнт не має відтворювати правило.
    canComplete: status === ITEM_STATUS.FROZEN && rows.length > 0 && rows.every((r) => r.packed),
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
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Взяти пропозицію в роботу. @returns {{ ok: boolean, offer?: object, lockedBy?: string }} */
async function claimOffer(offerId, telegramId, now = new Date()) {
  const me = String(telegramId || '');
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  return withOfferLock(offerId, async () => {
    const head = await SupplementOffer.findById(offerId);
    if (!head) return { ok: false, reason: 'supplement_offer_not_found' };
    if (head.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN) return { ok: false, reason: 'supplement_closed' };

    if (!isPackable(head)) {
      return { ok: false, reason: head.status === ITEM_STATUS.OPEN ? 'supplement_pack_before_freeze' : 'supplement_closed' };
    }

    const claimed = await SupplementOffer.findOneAndUpdate(
      {
        _id: offerId,
        itemStatus: { $ne: ITEM_RELATION_STATUS.WITHDRAWN },
        status: ITEM_STATUS.FROZEN,
        $or: [
          { lockedBy: null },
          { lockedBy: me },
          { lockedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { lockedBy: me, lockedAt: now } },
      { new: true },
    );
    if (claimed) {
      const out = claimed.toObject ? claimed.toObject() : claimed;
      return { ok: true, offer: out };
    }

    const existing = await SupplementOffer.findById(offerId, 'lockedBy status itemStatus waveId').lean();
    if (!existing) return { ok: false, reason: 'supplement_offer_not_found' };
    if (existing.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN || existing.status === ITEM_STATUS.COMPLETED || existing.status === ITEM_STATUS.CANCELLED) {
      return { ok: false, reason: 'supplement_closed' };
    }
    return { ok: false, reason: 'supplement_locked_by_other', lockedBy: String(existing.lockedBy || '') };
  });
}

/** Keep a legitimately long-running supplement card alive and report ownership. */
async function heartbeatOffer(offerId, telegramId, now = new Date()) {
  const me = String(telegramId || '');
  return withOfferLock(offerId, async () => {
    const head = await SupplementOffer.findById(offerId, 'waveId status itemStatus lockedBy lockedAt').lean();
    if (!head || head.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN) return { ok: true, held: false, state: 'missing' };
    if (!isPackable(head)) return { ok: true, held: false, state: head.status };

    const mine = await SupplementOffer.findOneAndUpdate(
      { _id: offerId, status: { $in: ACTIVE_STATUSES }, itemStatus: { $ne: ITEM_RELATION_STATUS.WITHDRAWN }, lockedBy: me },
      { $set: { lockedAt: now } },
      { new: true },
    );
    if (mine) return { ok: true, held: true, state: 'mine', offer: mine };

    const existing = await SupplementOffer.findById(offerId, 'lockedBy lockedAt status').lean();
    if (!existing) return { ok: true, held: false, state: 'missing' };
    if (existing.status === ITEM_STATUS.COMPLETED || existing.status === ITEM_STATUS.CANCELLED) return { ok: true, held: false, state: 'completed' };
    if (!existing.lockedBy) return { ok: true, held: false, state: 'available' };
    return {
      ok: true,
      held: false,
      state: String(existing.lockedBy) === me ? 'mine_stale' : 'other_worker',
      lockedBy: String(existing.lockedBy || ''),
    };
  });
}

/** Відпустити пропозицію (закрили картку). Тільки власник — чужий замок не чіпаємо. */
async function releaseOffer(offerId, telegramId) {
  return withOfferLock(offerId, () => SupplementOffer.updateOne(
    { _id: offerId, lockedBy: String(telegramId || '') },
    { $set: { lockedBy: null, lockedAt: null } },
  ));
}

/**
 * Ручне закриття прийому для конкретної групи в межах накладної.
 *
 * Legacy supplement receipt historically had exactly one target group, but new
 * regular receipts may contain several independent per-item supplement routes.
 * Therefore the current flow MUST freeze receipt+group, not the whole receipt.
 */
async function freezeReceiptOffers(receiptId, actor = {}, now = new Date(), { deliveryGroupId = null } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(receiptId || ''))) {
    throw Object.assign(new Error('receipt not found'), { code: 'receipt_not_found' });
  }

  const filter = { receiptId, status: ITEM_STATUS.OPEN, waveId: null };
  if (deliveryGroupId) filter.deliveryGroupId = String(deliveryGroupId);
  const open = await SupplementOffer.find(filter, '_id deliveryGroupId').lean();
  const frozen = [];
  for (const o of open) {
    const updated = await withOfferLock(o._id, () => SupplementOffer.findOneAndUpdate(
      { _id: o._id, status: ITEM_STATUS.OPEN },
      {
        $set: {
          status: ITEM_STATUS.FROZEN,
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

/**
 * Safety boundary: supplement ordering must never overlap the next ordinary
 * ordering window of the same delivery group. If warehouse staff forgot to
 * freeze an old wave manually, the scheduler freezes it as soon as that group's
 * normal ordering window opens. Existing requests remain available for packing;
 * sellers simply cannot add/change quantities anymore.
 */
async function freezeOffersForActiveOrderingWindows(now = new Date()) {
  const open = await SupplementOffer.find({ status: ITEM_STATUS.OPEN, waveId: null }, '_id receiptId deliveryGroupId').lean();
  if (!open.length) return 0;

  const groupIds = [...new Set(open.map((o) => String(o.deliveryGroupId || '')).filter(Boolean))];
  const groups = await DeliveryGroup.find({ _id: { $in: groupIds } }, '_id orderingSchedule').lean();
  const activeGroupIds = new Set(
    groups
      .filter((group) => group.orderingSchedule && isOrderingOpen(group.orderingSchedule, now).isOpen)
      .map((group) => String(group._id)),
  );
  if (!activeGroupIds.size) return 0;

  let frozenCount = 0;
  for (const offer of open) {
    if (!activeGroupIds.has(String(offer.deliveryGroupId))) continue;
    const updated = await withOfferLock(offer._id, () => SupplementOffer.findOneAndUpdate(
      { _id: offer._id, status: ITEM_STATUS.OPEN },
      {
        $set: {
          status: ITEM_STATUS.FROZEN,
          frozenAt: now,
          frozenBy: 'system:ordering-window',
          frozenByName: 'Автоматично: почалась звичайна сесія',
        },
      },
      { new: true },
    ));
    if (!updated) continue;
    frozenCount += 1;
    emit('supplement_frozen', {
      offerId: String(updated._id),
      receiptId: String(updated.receiptId),
      deliveryGroupId: String(updated.deliveryGroupId),
      reason: 'ordinary_ordering_opened',
    });
  }
  return frozenCount;
}

/** Після frozen звільняє позиції без заявок: без пакування немає COMPLETED. */
async function releaseEmptyOffers(now = new Date()) {
  const frozen = await SupplementOffer.find(
    { status: ITEM_STATUS.FROZEN, itemStatus: { $ne: ITEM_RELATION_STATUS.WITHDRAWN } },
    '_id deliveryGroupId waveId',
  ).lean();

  let closed = 0;
  const waveIds = new Set();
  for (const o of frozen) {
    const updated = await withOfferLock(o._id, async () => {
      const current = await SupplementOffer.findById(o._id, 'revision').lean();
      const revision = revisionOf(current);
      if (await SupplementRequest.exists({ offerId: o._id, revision, status: { $ne: REQUEST_STATUS.CANCELLED } })) return null;
      return SupplementOffer.findOneAndUpdate(
        { _id: o._id, status: ITEM_STATUS.FROZEN, itemStatus: { $ne: ITEM_RELATION_STATUS.WITHDRAWN } },
        {
          $set: {
            status: ITEM_STATUS.CANCELLED,
            completedAt: null,
            cancelledAt: now,
            cancelledBy: 'system',
            cancelledByName: 'Система',
            cancelReason: 'no_requests',
            lockedBy: null,
            lockedAt: null,
          },
        },
        { new: true },
      );
    });
    if (!updated) continue;
    closed += 1;
    if (updated.waveId) waveIds.add(String(updated.waveId));
    emit('supplement_cancelled', {
      offerId: String(o._id),
      waveId: o.waveId ? String(o.waveId) : null,
      deliveryGroupId: String(o.deliveryGroupId),
      reason: 'no_requests',
    });
  }
  for (const waveId of waveIds) {
    const wave = await recomputeWaveCompletion(waveId, {}, now).catch(() => null);
    if (wave) emit('supplement_wave_changed', { waveId, status: wave.status });
    if ([ITEM_STATUS.COMPLETED, ITEM_STATUS.CANCELLED].includes(wave?.status) && wave.orderingSessionId) {
      // A released empty Wave can be the final blocker of the delivery cycle.
      await require('../utils/sessionStatus').maybeCompleteSession(String(wave.orderingSessionId)).catch(() => {});
    }
  }
  return closed;
}

/** Завершує frozen-пропозицію, якщо всі заявки packed. */
async function completeOffer(offerId, actor = {}, now = new Date()) {
  const offer = await withOfferLock(offerId, async () => {
    const doc = await SupplementOffer.findById(offerId);
    if (!doc) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
    if (doc.itemStatus === ITEM_RELATION_STATUS.WITHDRAWN || doc.status === ITEM_STATUS.CANCELLED) {
      throw Object.assign(new Error('offer closed'), { code: 'supplement_closed' });
    }
    if (doc.status === ITEM_STATUS.COMPLETED) return doc;

    const wave = await loadWaveForOffer(doc, { lean: true });
    const effective = effectiveWaveItemStatus(doc, wave);
    if (effective !== ITEM_STATUS.FROZEN) {
      throw Object.assign(new Error('offer not frozen'), { code: 'supplement_not_frozen' });
    }
    if (actor?.by && String(doc.lockedBy || '') !== String(actor.by)) {
      throw Object.assign(new Error('offer not claimed'), { code: 'supplement_not_claimed' });
    }

    const revision = revisionOf(doc);
    const requests = await SupplementRequest.find(
      { offerId: doc._id, revision, status: { $ne: REQUEST_STATUS.CANCELLED } },
      'packed',
    ).lean();
    if (!requests.length) throw Object.assign(new Error('no requests'), { code: 'supplement_no_requests' });
    if (requests.some((r) => !r.packed)) {
      throw Object.assign(new Error('not all packed'), { code: 'supplement_not_all_packed' });
    }

    return SupplementOffer.findOneAndUpdate(
      { _id: doc._id, status: { $ne: ITEM_STATUS.COMPLETED }, itemStatus: { $ne: ITEM_RELATION_STATUS.WITHDRAWN } },
      {
        $set: {
          status: ITEM_STATUS.COMPLETED,
          completedAt: now,
          frozenAt: doc.frozenAt || wave?.frozenAt || now,
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
    waveId: offer.waveId ? String(offer.waveId) : null,
    deliveryGroupId: String(offer.deliveryGroupId),
    reason: 'packed',
  });
  if (offer.waveId) await recomputeWaveCompletion(String(offer.waveId), actor, now).catch(() => {});
  return offer;
}

// ─── Лічильники / вибірки ────────────────────────────────────────────────────

/**
 * Скільки хвиль групи ще в роботі — лічильник плитки віртуального блока
 * (routes/picking.js). Best-effort: підрахунок не має ламати екран збирання.
 */
async function countActiveOffersForGroup(deliveryGroupId, { orderingSessionId = null } = {}) {
  if (!deliveryGroupId) return 0;
  try {
    const clauses = [
      // Legacy rows predate session ownership and remain group-scoped until their
      // compatibility lifecycle is retired.
      { waveId: null, deliveryGroupId: String(deliveryGroupId), status: { $in: ACTIVE_STATUSES } },
    ];
    if (orderingSessionId) {
      clauses.push({
        waveId: { $ne: null },
        deliveryGroupId: String(deliveryGroupId),
        orderingSessionId: String(orderingSessionId),
        itemStatus: ITEM_RELATION_STATUS.ACTIVE,
        status: { $in: ACTIVE_ITEM_STATUSES },
      });
    }
    return await SupplementOffer.countDocuments({ $or: clauses });
  } catch (err) {
    return 0;
  }
}

/** Активні пропозиції групи для віртуального блока. */
async function findActiveOffersForGroup(deliveryGroupId, { orderingSessionId = null } = {}) {
  if (!deliveryGroupId) return [];
  const clauses = [
    { waveId: null, deliveryGroupId: String(deliveryGroupId), status: { $in: ACTIVE_STATUSES } },
  ];
  if (orderingSessionId) {
    clauses.push({
      waveId: { $ne: null },
      deliveryGroupId: String(deliveryGroupId),
      orderingSessionId: String(orderingSessionId),
      itemStatus: ITEM_RELATION_STATUS.ACTIVE,
      status: { $in: ACTIVE_ITEM_STATUSES },
    });
  }
  return SupplementOffer.find({ $or: clauses }).sort({ createdAt: 1 }).lean();
}

/** Товари пропозицій одним запитом (картки і каталог продавця). */
async function loadProductsFor(offers = []) {
  const ids = [...new Set(offers.map((o) => o.productId ? String(o.productId) : '').filter(Boolean))];
  if (!ids.length) return new Map();
  const products = await Product.find(
    { _id: { $in: ids } },
    '_id name brand model category warehouse orderNumber price quantityPerPackage imageUrls localImageUrl aiDescription',
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
  heartbeatOffer,
  releaseOffer,
  freezeReceiptOffers,
  freezeOffersForActiveOrderingWindows,
  releaseEmptyOffers,
  completeOffer,
  countActiveOffersForGroup,
  findActiveOffersForGroup,
  loadProductsFor,
};
