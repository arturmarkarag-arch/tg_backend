'use strict';

/**
 * V48.S2 Supplement Wave API.
 *
 * New rows are owned by SupplementWave (one DeliveryGroup + one OrderingSession).
 * SupplementOffer remains the item/legacy compatibility entity. Legacy rows with
 * waveId=null keep the old behaviour while new publications use Wave semantics.
 */
const express = require('express');
const mongoose = require('mongoose');

const Shop = require('../models/Shop');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const Receipt = require('../models/Receipt');

const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { assignLateShopNumber, buildShopNumberLookup } = require('../utils/shopNumbering');
const { getIO } = require('../socket');
const {
  ACTIVE_STATUSES,
  effectiveOfferStatus,
  resolveProductLocations,
  formatLocation,
  productView,
  offerViewForWarehouse,
  withOfferLock,
  claimOffer,
  heartbeatOffer,
  releaseOffer,
  freezeReceiptOffers,
  completeOffer,
  loadProductsFor,
} = require('../services/supplementOffers');
const {
  loadWaveForOffer,
  effectiveOfferStatus: effectiveWaveItemStatus,
  freezeWave,
  cancelWave,
} = require('../services/supplementWaveService');

const router = express.Router();
const sellerRoles = requireTelegramRoles(['seller', 'admin']);
const warehouseRoles = requireTelegramRoles(['warehouse', 'admin']);
const adminOnly = requireTelegramRoles(['admin']);

const MIN_QTY = 1;
const MAX_QTY = Number(process.env.MAX_QTY_PER_PRODUCT) || 6;

function str(v) { return v == null ? '' : String(v); }
function actorOf(user) {
  return {
    by: str(user?.telegramId),
    byName: [user?.firstName, user?.lastName].filter(Boolean).join(' '),
    byRole: user?.role || '',
  };
}
function emit(event, payload) {
  try { getIO()?.emit(event, payload); } catch (_) {}
}

async function sellerContext(user) {
  if (!user?.shopId) throw appError('no_shop');
  const shop = await Shop.findById(user.shopId).lean();
  if (!shop) throw appError('shop_not_found');
  if (shop.isActive === false) throw appError('shop_inactive');
  if (!shop.deliveryGroupId) throw appError('no_delivery_group');

  const group = await DeliveryGroup.findById(shop.deliveryGroupId, 'name dayOfWeek orderingSchedule').lean();
  if (!group) throw appError('delivery_group_not_found');
  let orderingSessionId = null;
  try { orderingSessionId = await findCurrentSessionId(str(group._id), group.orderingSchedule); } catch (_) {}

  return {
    shopId: str(shop._id),
    shopName: shop.name || '',
    deliveryGroupId: str(group._id),
    groupOrderingSchedule: group.orderingSchedule,
    groupName: group.name || '',
    orderingSessionId: orderingSessionId ? str(orderingSessionId) : null,
  };
}

function isOrdinaryOrderingOpenForSeller(ctx, now = new Date()) {
  return !!ctx?.groupOrderingSchedule && isOrderingOpen(ctx.groupOrderingSchedule, now).isOpen;
}

async function loadOfferAndWaveForSeller(offerId, ctx) {
  if (!mongoose.Types.ObjectId.isValid(str(offerId))) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(offerId);
  if (!offer) throw appError('supplement_offer_not_found');
  if (str(offer.deliveryGroupId) !== ctx.deliveryGroupId) throw appError('supplement_wrong_group');

  const wave = await loadWaveForOffer(offer, { lean: true });
  if (wave) {
    // Wave ownership is SESSION state. CURRENT topology never retargets it.
    if (!ctx.orderingSessionId || str(wave.orderingSessionId) !== ctx.orderingSessionId) {
      throw appError('supplement_wrong_group');
    }
    if (str(wave.deliveryGroupId) !== ctx.deliveryGroupId) throw appError('supplement_wrong_group');
  }
  return { offer, wave };
}

async function loadWaveMap(offers = []) {
  const ids = [...new Set(offers.map((o) => o.waveId ? str(o.waveId) : '').filter(Boolean))];
  if (!ids.length) return new Map();
  const waves = await SupplementWave.find({ _id: { $in: ids } }).lean();
  return new Map(waves.map((wave) => [str(wave._id), wave]));
}

function statusFor(offer, wave) {
  return wave ? effectiveWaveItemStatus(offer, wave) : effectiveOfferStatus(offer);
}

async function boxNumberSessionId(offer, group = null) {
  if (offer?.orderingSessionId) return str(offer.orderingSessionId);
  if (!group?.orderingSchedule) return null;
  try { return await findCurrentSessionId(str(offer.deliveryGroupId), group.orderingSchedule); } catch (_) { return null; }
}

// ─── SELLER ──────────────────────────────────────────────────────────────────

router.get('/available', sellerRoles, asyncHandler(async (req, res) => {
  const ctx = await sellerContext(req.telegramUser);
  const now = new Date();

  const newWaves = ctx.orderingSessionId
    ? await SupplementWave.find({
      deliveryGroupId: ctx.deliveryGroupId,
      orderingSessionId: ctx.orderingSessionId,
      status: { $in: ['open', 'frozen'] },
    }, '_id status').lean()
    : [];
  const waveIds = newWaves.map((wave) => wave._id);
  const waveMap = new Map(newWaves.map((wave) => [str(wave._id), wave]));

  const clauses = [];
  if (waveIds.length) clauses.push({ waveId: { $in: waveIds }, itemStatus: 'active' });
  // Legacy compatibility: old offers may only appear when ordinary ordering is
  // closed. New Wave rows intentionally coexist with ordinary ordering in the same
  // current delivery cycle and are session-scoped-excluded from ordinary catalog.
  if (!isOrdinaryOrderingOpenForSeller(ctx, now)) {
    clauses.push({ waveId: null, deliveryGroupId: ctx.deliveryGroupId, status: { $in: ACTIVE_STATUSES } });
  }
  if (!clauses.length) {
    return res.json({ offers: [], serverTime: now.toISOString(), shopId: ctx.shopId, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: ctx.orderingSessionId, groupName: ctx.groupName });
  }

  const offers = await SupplementOffer.find({ $or: clauses }).sort({ createdAt: 1 }).lean();
  if (!offers.length) {
    return res.json({ offers: [], serverTime: now.toISOString(), shopId: ctx.shopId, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: ctx.orderingSessionId, groupName: ctx.groupName });
  }
  const [productMap, requests] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offers.map((o) => o._id) }, shopId: ctx.shopId }).lean(),
  ]);
  const requestByOffer = new Map(requests.map((row) => [str(row.offerId), row]));

  res.json({
    serverTime: now.toISOString(),
    shopId: ctx.shopId,
    deliveryGroupId: ctx.deliveryGroupId,
    orderingSessionId: ctx.orderingSessionId,
    groupName: ctx.groupName,
    offers: offers.map((offer) => {
      const wave = offer.waveId ? waveMap.get(str(offer.waveId)) : null;
      const mine = requestByOffer.get(str(offer._id)) || null;
      const status = statusFor(offer, wave);
      return {
        offerId: str(offer._id),
        waveId: offer.waveId ? str(offer.waveId) : null,
        orderingSessionId: offer.orderingSessionId || wave?.orderingSessionId || null,
        status,
        product: productView(productMap.get(str(offer.productId)), offer),
        myQuantity: mine && mine.status !== 'cancelled' ? Number(mine.quantity || 0) : 0,
        locked: status !== 'open',
        packedAt: mine?.packedAt || null,
      };
    }),
  });
}));

router.post('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const { offer, wave } = await loadOfferAndWaveForSeller(req.params.offerId, ctx);
  // Only legacy offers retain the old ordinary-order overlap guard.
  if (!wave && isOrdinaryOrderingOpenForSeller(ctx)) throw appError('supplement_ordering_still_open', { group: ctx.groupName });

  const quantity = Math.trunc(Number(req.body?.quantity));
  if (!Number.isFinite(quantity) || quantity < MIN_QTY || quantity > MAX_QTY) throw appError('supplement_quantity_invalid');
  const actor = actorOf(user);

  const { action, request } = await withOfferLock(offer._id, async () => {
    const fresh = await SupplementOffer.findById(offer._id);
    if (!fresh) throw appError('supplement_offer_not_found');
    const freshWave = await loadWaveForOffer(fresh, { lean: true });
    const effective = statusFor(fresh, freshWave);
    if (effective !== 'open' || fresh.itemStatus === 'withdrawn') throw appError('supplement_closed');

    let existing = await SupplementRequest.findOne({ offerId: fresh._id, shopId: ctx.shopId });
    // Under the Wave contract packing cannot happen before freeze. Keep this
    // corruption guard but do not use packed=true as the normal seller lock.
    if (existing?.packed) throw appError('supplement_request_locked');

    if (existing) {
      const from = existing.status === 'cancelled' ? 0 : Number(existing.quantity || 0);
      if (existing.status === 'active' && from === quantity) return { action: 'noop', request: existing };
      existing.status = 'active';
      existing.cancelledAt = null;
      existing.cancelledBy = '';
      existing.cancelledByName = '';
      existing.cancelReason = '';
      existing.quantity = quantity;
      existing.updatedBy = actor.by;
      existing.updatedByName = actor.byName;
      existing.waveId = fresh.waveId || null;
      existing.orderingSessionId = fresh.orderingSessionId || freshWave?.orderingSessionId || null;
      existing.deliveryGroupId = str(fresh.deliveryGroupId);
      existing.history.push({ ...actor, at: new Date(), action: from === 0 ? 'restored' : 'quantity_changed', meta: { from, to: quantity } });
      await existing.save();
      return { action: from === 0 ? 'created' : 'updated', request: existing };
    }

    try {
      existing = await SupplementRequest.create({
        waveId: fresh.waveId || null,
        orderingSessionId: fresh.orderingSessionId || freshWave?.orderingSessionId || null,
        offerId: fresh._id,
        shopId: ctx.shopId,
        shopName: ctx.shopName,
        deliveryGroupId: ctx.deliveryGroupId,
        quantity,
        status: 'active',
        createdBy: actor.by,
        createdByName: actor.byName,
        updatedBy: actor.by,
        updatedByName: actor.byName,
        history: [{ ...actor, action: 'created', meta: { quantity } }],
      });
      return { action: 'created', request: existing };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const raced = await SupplementRequest.findOne({ offerId: fresh._id, shopId: ctx.shopId });
      if (!raced || raced.packed) throw appError('supplement_request_locked');
      const from = raced.status === 'cancelled' ? 0 : Number(raced.quantity || 0);
      raced.status = 'active';
      raced.quantity = quantity;
      raced.cancelledAt = null;
      raced.cancelledBy = '';
      raced.cancelledByName = '';
      raced.cancelReason = '';
      raced.updatedBy = actor.by;
      raced.updatedByName = actor.byName;
      raced.waveId = fresh.waveId || null;
      raced.orderingSessionId = fresh.orderingSessionId || freshWave?.orderingSessionId || null;
      raced.history.push({ ...actor, at: new Date(), action: 'quantity_changed', meta: { from, to: quantity, raced: true } });
      await raced.save();
      return { action: from === 0 ? 'created' : 'updated', request: raced };
    }
  });

  if (action !== 'noop') {
    const sessionId = offer.orderingSessionId || wave?.orderingSessionId || await boxNumberSessionId(offer, { orderingSchedule: ctx.groupOrderingSchedule });
    if (sessionId) {
      try { await assignLateShopNumber(str(sessionId), ctx.shopId, ctx.shopName); } catch (_) {}
    }
    emit('supplement_request_changed', { offerId: str(offer._id), waveId: offer.waveId ? str(offer.waveId) : null, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: sessionId ? str(sessionId) : null, shopId: ctx.shopId, action });
    emit('user_order_updated', { buyerTelegramId: str(user.telegramId) });
  }
  res.json({ ok: true, quantity: request.quantity, action });
}));

router.delete('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const { offer, wave } = await loadOfferAndWaveForSeller(req.params.offerId, ctx);
  if (!wave && isOrdinaryOrderingOpenForSeller(ctx)) throw appError('supplement_ordering_still_open', { group: ctx.groupName });
  const actor = actorOf(user);

  const action = await withOfferLock(offer._id, async () => {
    const fresh = await SupplementOffer.findById(offer._id);
    if (!fresh) throw appError('supplement_offer_not_found');
    const freshWave = await loadWaveForOffer(fresh, { lean: true });
    if (statusFor(fresh, freshWave) !== 'open' || fresh.itemStatus === 'withdrawn') throw appError('supplement_closed');

    const existing = await SupplementRequest.findOne({ offerId: fresh._id, shopId: ctx.shopId });
    if (!existing || existing.status === 'cancelled') return 'noop';
    if (existing.packed) throw appError('supplement_request_locked');

    if (freshWave) {
      existing.status = 'cancelled';
      existing.cancelledAt = new Date();
      existing.cancelledBy = actor.by;
      existing.cancelledByName = actor.byName;
      existing.cancelReason = 'seller_cancelled';
      existing.updatedBy = actor.by;
      existing.updatedByName = actor.byName;
      existing.history.push({ ...actor, at: new Date(), action: 'cancelled', meta: { reason: 'seller_cancelled' } });
      await existing.save();
    } else {
      await SupplementRequest.deleteOne({ _id: existing._id, packed: false });
    }
    return 'cancelled';
  });

  if (action !== 'noop') {
    emit('supplement_request_changed', { offerId: str(offer._id), waveId: offer.waveId ? str(offer.waveId) : null, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: wave?.orderingSessionId || null, shopId: ctx.shopId, action: 'cancelled' });
    emit('user_order_updated', { buyerTelegramId: str(user.telegramId) });
  }
  res.json({ ok: true, action });
}));

router.get('/my', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user?.shopId) return res.json({ requests: [] });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const requests = await SupplementRequest.find({ shopId: user.shopId, createdAt: { $gte: since } })
    .sort({ createdAt: -1 }).limit(100).lean();
  if (!requests.length) return res.json({ requests: [] });

  const offers = await SupplementOffer.find({ _id: { $in: requests.map((row) => row.offerId) } }).lean();
  const offerById = new Map(offers.map((offer) => [str(offer._id), offer]));
  const waveMap = await loadWaveMap(offers);
  const receiptIds = [...new Set(offers.map((offer) => str(offer.receiptId)).filter(Boolean))];
  const [productMap, receipts, shop] = await Promise.all([
    loadProductsFor(offers),
    Receipt.find({ _id: { $in: receiptIds } }, '_id receiptNumber').lean(),
    Shop.findById(user.shopId, 'name cityId').populate('cityId', 'name').lean(),
  ]);
  const receiptById = new Map(receipts.map((receipt) => [str(receipt._id), receipt]));

  res.json({
    serverTime: new Date().toISOString(),
    requests: requests.map((row) => {
      const offer = offerById.get(str(row.offerId));
      const wave = offer?.waveId ? waveMap.get(str(offer.waveId)) : null;
      const receiptId = offer ? str(offer.receiptId) : '';
      let status = offer ? statusFor(offer, wave) : 'completed';
      if (row.status === 'cancelled' || offer?.itemStatus === 'withdrawn' || wave?.status === 'cancelled') status = 'cancelled';
      return {
        requestId: str(row._id),
        offerId: str(row.offerId),
        waveId: offer?.waveId ? str(offer.waveId) : null,
        orderingSessionId: offer?.orderingSessionId || wave?.orderingSessionId || null,
        receiptId,
        receiptNumber: receiptById.get(receiptId)?.receiptNumber || '',
        createdAt: row.createdAt,
        openedAt: wave?.openedAt || offer?.openedAt || row.createdAt,
        quantity: row.quantity,
        packed: !!row.packed,
        status,
        product: productView(offer ? productMap.get(str(offer.productId)) : null, offer),
        shopName: row.shopName || shop?.name || '',
        shopCity: shop?.cityId?.name || '',
      };
    }),
  });
}));

// Existing admin/user history endpoint remains a read projection; cancelled rows
// stay visible instead of being physically deleted for new Wave data.
router.get('/admin/seller/:telegramId', adminOnly, asyncHandler(async (req, res) => {
  const telegramId = str(req.params.telegramId).trim();
  if (!telegramId) return res.json({ requests: [] });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 500));
  const filter = { createdBy: telegramId };
  const [total, requests] = await Promise.all([
    SupplementRequest.countDocuments(filter),
    SupplementRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
  ]);
  if (!requests.length) return res.json({ requests: [], total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) });

  const offers = await SupplementOffer.find({ _id: { $in: requests.map((row) => row.offerId) } }).lean();
  const offerById = new Map(offers.map((offer) => [str(offer._id), offer]));
  const waveMap = await loadWaveMap(offers);
  const receiptIds = [...new Set(offers.map((offer) => str(offer.receiptId)).filter(Boolean))];
  const shopIds = [...new Set(requests.map((row) => str(row.shopId)).filter(Boolean))];
  const [productMap, receipts, shops] = await Promise.all([
    loadProductsFor(offers),
    Receipt.find({ _id: { $in: receiptIds } }, '_id receiptNumber').lean(),
    Shop.find({ _id: { $in: shopIds } }, 'name cityId deliveryGroupId').populate('cityId', 'name').lean(),
  ]);
  const receiptById = new Map(receipts.map((receipt) => [str(receipt._id), receipt]));
  const shopById = new Map(shops.map((shop) => [str(shop._id), shop]));

  res.json({
    serverTime: new Date().toISOString(), total, page, pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    requests: requests.map((row) => {
      const offer = offerById.get(str(row.offerId));
      const wave = offer?.waveId ? waveMap.get(str(offer.waveId)) : null;
      const receiptId = offer ? str(offer.receiptId) : '';
      const shop = shopById.get(str(row.shopId));
      let status = offer ? statusFor(offer, wave) : 'completed';
      if (row.status === 'cancelled' || offer?.itemStatus === 'withdrawn' || wave?.status === 'cancelled') status = 'cancelled';
      return {
        requestId: str(row._id), offerId: str(row.offerId), waveId: offer?.waveId ? str(offer.waveId) : null,
        orderingSessionId: offer?.orderingSessionId || wave?.orderingSessionId || null,
        receiptId, receiptNumber: receiptById.get(receiptId)?.receiptNumber || '',
        createdAt: row.createdAt, openedAt: wave?.openedAt || offer?.openedAt || row.createdAt,
        quantity: row.quantity, packed: !!row.packed, status,
        product: productView(offer ? productMap.get(str(offer.productId)) : null, offer),
        shopName: row.shopName || shop?.name || '', shopCity: shop?.cityId?.name || '',
        deliveryGroupId: str(row.deliveryGroupId || offer?.deliveryGroupId || shop?.deliveryGroupId),
      };
    }),
  });
}));

// ─── WAREHOUSE ───────────────────────────────────────────────────────────────

async function currentSessionForGroup(groupId) {
  const group = await DeliveryGroup.findById(groupId, 'orderingSchedule').lean();
  if (!group) return { group: null, sessionId: null };
  let sessionId = null;
  try { sessionId = await findCurrentSessionId(str(groupId), group.orderingSchedule); } catch (_) {}
  return { group, sessionId: sessionId ? str(sessionId) : null };
}

async function activeOffersForGroupSession(groupId, sessionId, group) {
  const clauses = [];
  if (sessionId) {
    const waves = await SupplementWave.find({
      deliveryGroupId: str(groupId), orderingSessionId: str(sessionId), status: { $in: ['open', 'frozen'] },
    }, '_id status').lean();
    if (waves.length) clauses.push({ waveId: { $in: waves.map((wave) => wave._id) }, itemStatus: 'active' });
  }
  // Legacy remains group-scoped and uses its historical lifecycle.
  clauses.push({ waveId: null, deliveryGroupId: str(groupId), status: { $in: ACTIVE_STATUSES } });
  const offers = await SupplementOffer.find({ $or: clauses }).sort({ createdAt: 1 }).lean();
  const waveMap = await loadWaveMap(offers);
  for (const offer of offers) {
    if (offer.waveId) offer.waveStatus = waveMap.get(str(offer.waveId))?.status || offer.status;
  }
  return offers;
}

router.get('/group/:deliveryGroupId', warehouseRoles, asyncHandler(async (req, res) => {
  const groupId = str(req.params.deliveryGroupId);
  if (!mongoose.Types.ObjectId.isValid(groupId)) return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString() });
  const { group, sessionId } = await currentSessionForGroup(groupId);
  if (!group) return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString() });

  const offers = await activeOffersForGroupSession(groupId, sessionId, group);
  if (!offers.length) return res.json({ offers: [], totalQty: 0, serverTime: new Date().toISOString(), orderingSessionId: sessionId });

  const [productMap, requests, locations, receipts] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offers.map((o) => o._id) }, status: { $ne: 'cancelled' } }, 'offerId quantity packed').lean(),
    resolveProductLocations(offers.map((offer) => offer.productId).filter(Boolean)),
    Receipt.find({ _id: { $in: [...new Set(offers.map((offer) => offer.receiptId))] } }, '_id receiptNumber').lean(),
  ]);
  const receiptNumberById = new Map(receipts.map((receipt) => [str(receipt._id), receipt.receiptNumber || '']));
  const byOffer = new Map();
  for (const row of requests) {
    const key = str(row.offerId);
    if (!byOffer.has(key)) byOffer.set(key, []);
    byOffer.get(key).push(row);
  }
  const list = offers.map((offer) => {
    const rows = byOffer.get(str(offer._id)) || [];
    const status = effectiveOfferStatus(offer);
    const location = offer.productId ? locations.get(str(offer.productId)) : null;
    return {
      offerId: str(offer._id), waveId: offer.waveId ? str(offer.waveId) : null,
      orderingSessionId: offer.orderingSessionId || null,
      receiptId: str(offer.receiptId), receiptNumber: receiptNumberById.get(str(offer.receiptId)) || '',
      status, product: productView(productMap.get(str(offer.productId)), offer), locationLabel: formatLocation(location),
      shopCount: rows.length, totalQty: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      packedCount: rows.filter((row) => row.packed).length,
      canPack: status === 'frozen',
      canComplete: status === 'frozen' && rows.length > 0 && rows.every((row) => row.packed),
    };
  });
  res.json({ serverTime: new Date().toISOString(), orderingSessionId: sessionId, offers: list, totalQty: list.reduce((sum, row) => sum + row.totalQty, 0) });
}));

async function buildOfferCard(offer, me = '') {
  const group = await DeliveryGroup.findById(offer.deliveryGroupId, 'orderingSchedule').lean();
  const sessionId = await boxNumberSessionId(offer, group);
  const [requests, locations, productMap, session, wave] = await Promise.all([
    SupplementRequest.find({ offerId: offer._id, status: { $ne: 'cancelled' } }).lean(),
    offer.productId ? resolveProductLocations([offer.productId]) : Promise.resolve(new Map()),
    loadProductsFor([offer]),
    sessionId ? OrderingSession.findById(sessionId, 'shopNumbers').lean() : null,
    loadWaveForOffer(offer, { lean: true }),
  ]);
  const lookup = buildShopNumberLookup(session?.shopNumbers);
  const decorated = { ...offer, waveStatus: wave?.status || offer.waveStatus };
  const view = offerViewForWarehouse(decorated, {
    product: productMap.get(str(offer.productId)), requests,
    location: offer.productId ? locations.get(str(offer.productId)) : null,
    boxNumberFor: (row) => lookup.byId.get(str(row.shopId)) ?? lookup.byName.get(str(row.shopName)) ?? null,
  });
  view.waveId = offer.waveId ? str(offer.waveId) : null;
  view.orderingSessionId = offer.orderingSessionId || wave?.orderingSessionId || sessionId || null;
  view.lockedByMe = !!me && str(offer.lockedBy) === str(me);
  view.canPack = view.status === 'frozen';
  return view;
}

// New canonical Wave freeze. Packing is structurally impossible before this.
router.post('/waves/:waveId/freeze', warehouseRoles, asyncHandler(async (req, res) => {
  let wave;
  try { wave = await freezeWave(req.params.waveId, actorOf(req.telegramUser)); }
  catch (err) {
    if (err?.code && str(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  // Notify the lifecycle boundary before an empty Wave auto-completes; otherwise
  // status=completed would make the frozen notification legitimately unclaimable.
  await require('../services/supplementNotify').notifyWaves([wave.toObject ? wave.toObject() : wave], 'frozen').catch(() => {});
  const { autoCompleteEmptyOffers } = require('../services/supplementOffers');
  await autoCompleteEmptyOffers(new Date());
  const finalWave = await SupplementWave.findById(wave._id, 'status').lean();
  res.json({ ok: true, waveId: str(wave._id), status: finalWave?.status || wave.status });
}));

// Admin cancellation is a compensating stop, never a physical rollback.
router.post('/waves/:waveId/cancel', adminOnly, asyncHandler(async (req, res) => {
  const reason = str(req.body?.reason || 'cancelled_by_admin').trim() || 'cancelled_by_admin';
  let wave;
  try { wave = await cancelWave(req.params.waveId, actorOf(req.telegramUser), reason); }
  catch (err) {
    if (err?.code && str(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  await require('../services/supplementNotify').notifyWaves([wave.toObject ? wave.toObject() : wave], 'cancelled').catch(() => {});
  if (wave?.orderingSessionId) await require('../utils/sessionStatus').maybeCompleteSession(str(wave.orderingSessionId)).catch(() => {});
  res.json({ ok: true, waveId: str(wave._id), status: wave.status });
}));

// Legacy receipt-level freeze remains compatibility-only for old waveId=null rows.
router.post('/receipts/:receiptId/freeze', warehouseRoles, asyncHandler(async (req, res) => {
  const receiptId = str(req.params.receiptId);
  if (!mongoose.Types.ObjectId.isValid(receiptId)) throw appError('receipt_not_found');
  const receipt = await Receipt.findById(receiptId, 'type targetDeliveryGroupId').lean();
  if (!receipt) throw appError('receipt_not_found');
  const deliveryGroupId = str(req.body?.deliveryGroupId || (receipt.type === 'supplement' ? receipt.targetDeliveryGroupId : ''));
  if (!mongoose.Types.ObjectId.isValid(deliveryGroupId)) throw appError('supplement_target_required');
  const frozen = await freezeReceiptOffers(receiptId, actorOf(req.telegramUser), new Date(), { deliveryGroupId });
  const { autoCompleteEmptyOffers } = require('../services/supplementOffers');
  await autoCompleteEmptyOffers(new Date());
  res.json({ ok: true, frozenCount: frozen.length, deliveryGroupId, legacy: true });
}));

router.get('/offers/:offerId', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const offer = await SupplementOffer.findById(req.params.offerId).lean();
  if (!offer) throw appError('supplement_offer_not_found');
  res.json({ offer: await buildOfferCard(offer, req.telegramUser?.telegramId), serverTime: new Date().toISOString() });
}));

router.post('/offers/:offerId/claim', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const me = str(req.telegramUser?.telegramId);
  const result = await claimOffer(req.params.offerId, me);
  if (!result.ok) {
    if (result.reason === 'supplement_locked_by_other') {
      const holder = result.lockedBy ? await User.findOne({ telegramId: result.lockedBy }, 'firstName lastName').lean() : null;
      const name = holder ? [holder.firstName, holder.lastName].filter(Boolean).join(' ') : '';
      throw appError('supplement_locked_by_other', { name });
    }
    throw appError(result.reason);
  }
  const claimed = result.offer.toObject ? result.offer.toObject() : result.offer;
  res.json({ offer: await buildOfferCard(claimed, me), serverTime: new Date().toISOString() });
}));

router.post('/offers/:offerId/heartbeat', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  const result = await heartbeatOffer(req.params.offerId, req.telegramUser?.telegramId);
  res.json({ ok: true, held: !!result.held, state: result.state || 'missing', serverTime: new Date().toISOString() });
}));

router.post('/offers/:offerId/release', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.offerId)) throw appError('supplement_offer_not_found');
  await releaseOffer(req.params.offerId, req.telegramUser?.telegramId);
  res.json({ ok: true });
}));

router.patch('/requests/:requestId/packed', warehouseRoles, asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.requestId)) throw appError('supplement_request_not_found');
  const packed = req.body?.packed !== false;
  const actor = actorOf(req.telegramUser);
  const head = await SupplementRequest.findById(req.params.requestId, 'offerId shopId status').lean();
  if (!head || head.status === 'cancelled') throw appError('supplement_request_not_found');

  const offer = await withOfferLock(head.offerId, async () => {
    const fresh = await SupplementOffer.findById(head.offerId);
    if (!fresh) throw appError('supplement_offer_not_found');
    const wave = await loadWaveForOffer(fresh, { lean: true });
    const effective = statusFor(fresh, wave);
    if (effective !== 'frozen') {
      if (effective === 'open') throw appError('supplement_pack_before_freeze');
      throw appError('supplement_closed');
    }
    if (str(fresh.lockedBy) !== actor.by) throw appError('supplement_not_claimed');

    await SupplementOffer.updateOne({ _id: fresh._id, lockedBy: actor.by }, { $set: { lockedAt: new Date() } });
    await SupplementRequest.updateOne(
      { _id: req.params.requestId, status: 'active', packed: !packed },
      {
        $set: { packed, packedBy: packed ? actor.by : '', packedByName: packed ? actor.byName : '', packedAt: packed ? new Date() : null },
        $push: { history: { ...actor, at: new Date(), action: packed ? 'packed' : 'unpacked' } },
      },
    );
    const out = fresh.toObject();
    if (wave) out.waveStatus = wave.status;
    return out;
  });

  emit('supplement_packed_changed', { offerId: str(offer._id), waveId: offer.waveId ? str(offer.waveId) : null, deliveryGroupId: str(offer.deliveryGroupId), requestId: str(head._id), shopId: str(head.shopId), packed });
  res.json({ offer: await buildOfferCard(offer, actor.by) });
}));

router.post('/offers/:offerId/complete', warehouseRoles, asyncHandler(async (req, res) => {
  let offer;
  try { offer = await completeOffer(req.params.offerId, actorOf(req.telegramUser)); }
  catch (err) {
    if (err?.code && str(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  if (offer?.orderingSessionId) await require('../utils/sessionStatus').maybeCompleteSession(str(offer.orderingSessionId)).catch(() => {});
  res.json({ ok: true });
}));

module.exports = router;
