'use strict';

/**
 * V48.S3 Supplement API.
 *
 * Modern state uses one stable SupplementWave container per DeliveryGroup + exact
 * OrderingSession. SupplementOffer is the independently repeatable item slot; its
 * revision owns current requests. Legacy waveId=null rows remain compatibility-only.
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
const { ITEM_STATUS, ITEM_RELATION_STATUS, REQUEST_STATUS, ACTIVE_ITEM_STATUSES, revisionOf, sellerMayRestoreRequest } = require('../utils/supplementState');
const { offerSnapshotForRequestRevision } = require('../services/supplementRevisionProjection');
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
  cancelOfferRevision,
} = require('../services/supplementWaveService');
const {
  createSellerRequest,
  updateSellerRequest,
  cancelSellerRequest,
  cancelRequestByStaff,
  restoreRequestByStaff,
} = require('../services/supplementRequestCommand');

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

async function currentRequestsForOffers(offers, extra = {}, projection = null) {
  const pairs = (offers || []).map((offer) => ({
    offerId: offer._id,
    revision: revisionOf(offer),
  }));
  if (!pairs.length) return [];
  let query = SupplementRequest.find({ $or: pairs, ...extra });
  if (projection) query = query.select(projection);
  return query.lean();
}


// ─── SELLER ──────────────────────────────────────────────────────────────────

router.get('/available', sellerRoles, asyncHandler(async (req, res) => {
  const ctx = await sellerContext(req.telegramUser);
  const now = new Date();
  const clauses = [];
  if (ctx.orderingSessionId) {
    clauses.push({
      waveId: { $ne: null },
      deliveryGroupId: ctx.deliveryGroupId,
      orderingSessionId: ctx.orderingSessionId,
      itemStatus: ITEM_RELATION_STATUS.ACTIVE,
      status: { $in: ACTIVE_ITEM_STATUSES },
    });
  }
  // Legacy compatibility remains group-scoped and hidden while normal ordering is open.
  if (!isOrdinaryOrderingOpenForSeller(ctx, now)) {
    clauses.push({ waveId: null, deliveryGroupId: ctx.deliveryGroupId, status: { $in: ACTIVE_STATUSES } });
  }
  if (!clauses.length) {
    return res.json({ offers: [], serverTime: now.toISOString(), shopId: ctx.shopId, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: ctx.orderingSessionId, groupName: ctx.groupName });
  }

  const offers = await SupplementOffer.find({ $or: clauses }).sort({ openedAt: 1, _id: 1 }).lean();
  if (!offers.length) {
    return res.json({ offers: [], serverTime: now.toISOString(), shopId: ctx.shopId, deliveryGroupId: ctx.deliveryGroupId, orderingSessionId: ctx.orderingSessionId, groupName: ctx.groupName });
  }
  const [productMap, requests] = await Promise.all([
    loadProductsFor(offers),
    SupplementRequest.find({ offerId: { $in: offers.map((o) => o._id) }, shopId: ctx.shopId }).lean(),
  ]);
  const requestByOfferRevision = new Map(requests.map((row) => [`${str(row.offerId)}:${revisionOf(row)}`, row]));
  const waveMap = await loadWaveMap(offers);

  res.json({
    serverTime: now.toISOString(),
    shopId: ctx.shopId,
    deliveryGroupId: ctx.deliveryGroupId,
    orderingSessionId: ctx.orderingSessionId,
    groupName: ctx.groupName,
    offers: offers.map((offer) => {
      const revision = revisionOf(offer);
      const wave = offer.waveId ? waveMap.get(str(offer.waveId)) : null;
      const mine = requestByOfferRevision.get(`${str(offer._id)}:${revision}`) || null;
      const status = statusFor(offer, wave);
      const sellerBlocked = !!(mine && mine.status === REQUEST_STATUS.CANCELLED && !sellerMayRestoreRequest(mine));
      return {
        offerId: str(offer._id),
        waveId: offer.waveId ? str(offer.waveId) : null,
        revision,
        orderingSessionId: offer.orderingSessionId || wave?.orderingSessionId || null,
        status,
        product: productView(productMap.get(str(offer.productId)), offer),
        myRequestId: mine && mine.status !== REQUEST_STATUS.CANCELLED ? str(mine._id) : null,
        myQuantity: mine && mine.status !== REQUEST_STATUS.CANCELLED ? Number(mine.quantity || 0) : 0,
        sellerBlocked,
        sellerBlockedReason: sellerBlocked ? 'staff_cancelled' : null,
        locked: status !== ITEM_STATUS.OPEN || sellerBlocked,
        packedAt: mine?.packedAt || null,
      };
    }),
  });
}));

async function afterSellerRequestMutation({ offer, ctx, user, action, request }) {
  if (action === 'noop') return;
  const sessionId = offer.orderingSessionId || ctx.orderingSessionId || null;
  if (sessionId && action === 'created') {
    try { await assignLateShopNumber(str(sessionId), ctx.shopId, ctx.shopName); } catch (_) {}
  }
  emit('supplement_request_changed', {
    offerId: str(offer._id),
    waveId: offer.waveId ? str(offer.waveId) : null,
    revision: revisionOf(offer),
    requestId: request?._id ? str(request._id) : null,
    deliveryGroupId: ctx.deliveryGroupId,
    orderingSessionId: sessionId ? str(sessionId) : null,
    shopId: ctx.shopId,
    action,
  });
  emit('user_order_updated', { buyerTelegramId: str(user.telegramId) });
}

// Canonical V48.S3 seller CRUD.
router.post('/offers/:offerId/requests', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const { offer } = await loadOfferAndWaveForSeller(req.params.offerId, ctx);
  const result = await createSellerRequest({
    offerId: offer._id, ctx, quantity: req.body?.quantity, actor: actorOf(user), min: MIN_QTY, max: MAX_QTY,
  });
  await afterSellerRequestMutation({ offer: result.offer, ctx, user, action: result.action, request: result.request });
  res.status(201).json({ ok: true, requestId: str(result.request._id), quantity: result.request.quantity, action: result.action });
}));

router.patch('/requests/:requestId', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const result = await updateSellerRequest({
    requestId: req.params.requestId, ctx, quantity: req.body?.quantity, actor: actorOf(user), min: MIN_QTY, max: MAX_QTY,
  });
  await afterSellerRequestMutation({ offer: result.offer, ctx, user, action: result.action, request: result.request });
  res.json({ ok: true, requestId: str(result.request._id), quantity: result.request.quantity, action: result.action });
}));

router.delete('/requests/:requestId', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const result = await cancelSellerRequest({ requestId: req.params.requestId, ctx, actor: actorOf(user) });
  await afterSellerRequestMutation({ offer: result.offer, ctx, user, action: result.action, request: result.request });
  res.json({ ok: true, action: result.action });
}));

// Compatibility-only upsert for cached S2 clients. New UI never uses it.
router.post('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const { offer } = await loadOfferAndWaveForSeller(req.params.offerId, ctx);
  const revision = revisionOf(offer);
  const existing = await SupplementRequest.findOne({ offerId: offer._id, revision, shopId: ctx.shopId }).lean();
  const result = existing?.status === REQUEST_STATUS.ACTIVE
    ? await updateSellerRequest({ requestId: existing._id, ctx, quantity: req.body?.quantity, actor: actorOf(user), min: MIN_QTY, max: MAX_QTY })
    : await createSellerRequest({ offerId: offer._id, ctx, quantity: req.body?.quantity, actor: actorOf(user), min: MIN_QTY, max: MAX_QTY });
  await afterSellerRequestMutation({ offer: result.offer, ctx, user, action: result.action, request: result.request });
  res.json({ ok: true, requestId: str(result.request._id), quantity: result.request.quantity, action: result.action, compatibility: true });
}));

router.delete('/:offerId/request', sellerRoles, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const ctx = await sellerContext(user);
  const { offer } = await loadOfferAndWaveForSeller(req.params.offerId, ctx);
  const revision = revisionOf(offer);
  const existing = await SupplementRequest.findOne({ offerId: offer._id, revision, shopId: ctx.shopId }).lean();
  if (!existing || existing.status === REQUEST_STATUS.CANCELLED) return res.json({ ok: true, action: 'noop', compatibility: true });
  const result = await cancelSellerRequest({ requestId: existing._id, ctx, actor: actorOf(user) });
  await afterSellerRequestMutation({ offer: result.offer, ctx, user, action: result.action, request: result.request });
  res.json({ ok: true, action: result.action, compatibility: true });
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
      const baseOffer = offerById.get(str(row.offerId));
      const offer = offerSnapshotForRequestRevision(baseOffer, row);
      const wave = offer?.waveId ? waveMap.get(str(offer.waveId)) : null;
      const receiptId = offer ? str(offer.receiptId) : '';
      let status = offer ? statusFor(offer, wave) : 'completed';
      if (row.status === REQUEST_STATUS.CANCELLED) status = REQUEST_STATUS.CANCELLED;
      return {
        requestId: str(row._id),
        offerId: str(row.offerId),
        revision: revisionOf(row),
        waveId: offer?.waveId ? str(offer.waveId) : null,
        orderingSessionId: offer?.orderingSessionId || wave?.orderingSessionId || null,
        receiptId,
        receiptNumber: receiptById.get(receiptId)?.receiptNumber || '',
        createdAt: row.createdAt,
        openedAt: offer?.openedAt || wave?.openedAt || row.createdAt,
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
      const baseOffer = offerById.get(str(row.offerId));
      const offer = offerSnapshotForRequestRevision(baseOffer, row);
      const wave = offer?.waveId ? waveMap.get(str(offer.waveId)) : null;
      const receiptId = offer ? str(offer.receiptId) : '';
      const shop = shopById.get(str(row.shopId));
      let status = offer ? statusFor(offer, wave) : 'completed';
      if (row.status === REQUEST_STATUS.CANCELLED) status = REQUEST_STATUS.CANCELLED;
      return {
        requestId: str(row._id), offerId: str(row.offerId), revision: revisionOf(row), waveId: offer?.waveId ? str(offer.waveId) : null,
        orderingSessionId: offer?.orderingSessionId || wave?.orderingSessionId || null,
        receiptId, receiptNumber: receiptById.get(receiptId)?.receiptNumber || '',
        createdAt: row.createdAt, openedAt: offer?.openedAt || wave?.openedAt || row.createdAt,
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
    clauses.push({
      waveId: { $ne: null },
      deliveryGroupId: str(groupId),
      orderingSessionId: str(sessionId),
      itemStatus: ITEM_RELATION_STATUS.ACTIVE,
      status: { $in: ACTIVE_ITEM_STATUSES },
    });
  }
  // Legacy remains group-scoped and uses its historical lifecycle.
  clauses.push({ waveId: null, deliveryGroupId: str(groupId), status: { $in: ACTIVE_STATUSES } });
  return SupplementOffer.find({ $or: clauses }).sort({ openedAt: 1, _id: 1 }).lean();
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
    currentRequestsForOffers(offers, { status: { $ne: REQUEST_STATUS.CANCELLED } }, 'offerId revision quantity packed'),
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
      revision: revisionOf(offer),
      orderingSessionId: offer.orderingSessionId || null,
      receiptId: str(offer.receiptId), receiptNumber: receiptNumberById.get(str(offer.receiptId)) || '',
      status, product: productView(productMap.get(str(offer.productId)), offer), locationLabel: formatLocation(location),
      shopCount: rows.length, totalQty: rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      packedCount: rows.filter((row) => row.packed).length,
      canPack: status === ITEM_STATUS.FROZEN,
      canComplete: status === ITEM_STATUS.FROZEN && rows.length > 0 && rows.every((row) => row.packed),
    };
  });
  res.json({ serverTime: new Date().toISOString(), orderingSessionId: sessionId, offers: list, totalQty: list.reduce((sum, row) => sum + row.totalQty, 0) });
}));

async function buildOfferCard(offer, me = '') {
  const group = await DeliveryGroup.findById(offer.deliveryGroupId, 'orderingSchedule').lean();
  const sessionId = await boxNumberSessionId(offer, group);
  const [requests, locations, productMap, session, wave] = await Promise.all([
    SupplementRequest.find({ offerId: offer._id, revision: revisionOf(offer), status: { $ne: REQUEST_STATUS.CANCELLED } }).lean(),
    offer.productId ? resolveProductLocations([offer.productId]) : Promise.resolve(new Map()),
    loadProductsFor([offer]),
    sessionId ? OrderingSession.findById(sessionId, 'shopNumbers').lean() : null,
    loadWaveForOffer(offer, { lean: true }),
  ]);
  const lookup = buildShopNumberLookup(session?.shopNumbers);
  const decorated = { ...offer };
  const view = offerViewForWarehouse(decorated, {
    product: productMap.get(str(offer.productId)), requests,
    location: offer.productId ? locations.get(str(offer.productId)) : null,
    boxNumberFor: (row) => lookup.byId.get(str(row.shopId)) ?? lookup.byName.get(str(row.shopName)) ?? null,
  });
  view.waveId = offer.waveId ? str(offer.waveId) : null;
  view.orderingSessionId = offer.orderingSessionId || wave?.orderingSessionId || sessionId || null;
  view.revision = revisionOf(offer);
  view.lockedByMe = !!me && str(offer.lockedBy) === str(me);
  view.canPack = view.status === ITEM_STATUS.FROZEN;
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
  // Notify the lifecycle boundary before no-request items are released.
  await require('../services/supplementNotify').notifyWaves([wave.toObject ? wave.toObject() : wave], 'frozen').catch(() => {});
  const { releaseEmptyOffers } = require('../services/supplementOffers');
  await releaseEmptyOffers(new Date());
  const finalWave = await SupplementWave.findById(wave._id, 'status').lean();
  res.json({ ok: true, waveId: str(wave._id), status: finalWave?.status || wave.status });
}));

// Admin cancellation is a compensating stop, never a physical rollback.
router.post('/waves/:waveId/cancel', warehouseRoles, asyncHandler(async (req, res) => {
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
  const { releaseEmptyOffers } = require('../services/supplementOffers');
  await releaseEmptyOffers(new Date());
  res.json({ ok: true, frozenCount: frozen.length, deliveryGroupId, legacy: true });
}));

// Staff compensation controls: one shop request or one product revision.
router.post('/requests/:requestId/cancel', warehouseRoles, asyncHandler(async (req, res) => {
  const reason = str(req.body?.reason || 'cancelled_by_staff').trim() || 'cancelled_by_staff';
  const result = await cancelRequestByStaff({ requestId: req.params.requestId, actor: actorOf(req.telegramUser), reason });
  if (result?.offer) {
    emit('supplement_request_changed', {
      offerId: str(result.offer._id), waveId: result.offer.waveId ? str(result.offer.waveId) : null,
      revision: revisionOf(result.offer), deliveryGroupId: str(result.offer.deliveryGroupId),
      orderingSessionId: result.offer.orderingSessionId || null, requestId: str(req.params.requestId), action: result.action,
    });
    // A FROZEN item cannot accept replacement seller demand. If staff cancelled
    // its last unpacked request, close that empty current revision immediately;
    // do not leave current-session truth dependent on the minute scheduler.
    if (result.offer.status === ITEM_STATUS.FROZEN && result.action === 'cancelled') {
      const { releaseEmptyOffers } = require('../services/supplementOffers');
      await releaseEmptyOffers(new Date());
      if (result.offer.orderingSessionId) {
        await require('../utils/sessionStatus').maybeCompleteSession(str(result.offer.orderingSessionId)).catch(() => {});
      }
    }
  }
  res.json({ ok: true, action: result.action });
}));

router.post('/requests/:requestId/restore', warehouseRoles, asyncHandler(async (req, res) => {
  const result = await restoreRequestByStaff({ requestId: req.params.requestId, actor: actorOf(req.telegramUser) });
  if (result?.offer) {
    emit('supplement_request_changed', {
      offerId: str(result.offer._id), waveId: result.offer.waveId ? str(result.offer.waveId) : null,
      revision: revisionOf(result.offer), deliveryGroupId: str(result.offer.deliveryGroupId),
      orderingSessionId: result.offer.orderingSessionId || null, requestId: str(req.params.requestId), action: result.action,
    });
  }
  res.json({ ok: true, action: result.action, quantity: result.request?.quantity || 0 });
}));

router.post('/offers/:offerId/cancel', warehouseRoles, asyncHandler(async (req, res) => {
  const reason = str(req.body?.reason || 'cancelled_by_staff').trim() || 'cancelled_by_staff';
  let offer;
  try { offer = await cancelOfferRevision(req.params.offerId, actorOf(req.telegramUser), reason); }
  catch (err) {
    if (err?.code && str(err.code).startsWith('supplement_')) throw appError(err.code);
    throw err;
  }
  if (offer?.orderingSessionId) await require('../utils/sessionStatus').maybeCompleteSession(str(offer.orderingSessionId)).catch(() => {});
  res.json({ ok: true, offerId: str(offer._id), revision: revisionOf(offer), status: offer.status });
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
  const head = await SupplementRequest.findById(req.params.requestId, 'offerId revision shopId status packed').lean();
  if (!head || head.status === REQUEST_STATUS.CANCELLED) throw appError('supplement_request_not_found');

  const offer = await withOfferLock(head.offerId, async () => {
    const fresh = await SupplementOffer.findById(head.offerId);
    if (!fresh) throw appError('supplement_offer_not_found');
    const revision = revisionOf(fresh);
    if (revisionOf(head) !== revision) throw appError('supplement_request_not_found');
    const wave = await loadWaveForOffer(fresh, { lean: true });
    const effective = statusFor(fresh, wave);
    if (effective !== ITEM_STATUS.FROZEN) {
      if (effective === ITEM_STATUS.OPEN) throw appError('supplement_pack_before_freeze');
      throw appError('supplement_closed');
    }
    if (str(fresh.lockedBy) !== actor.by) throw appError('supplement_not_claimed');

    await SupplementOffer.updateOne({ _id: fresh._id, lockedBy: actor.by }, { $set: { lockedAt: new Date() } });
    await SupplementRequest.updateOne(
      { _id: req.params.requestId, revision, status: REQUEST_STATUS.ACTIVE, packed: !packed },
      {
        $set: { packed, packedBy: packed ? actor.by : '', packedByName: packed ? actor.byName : '', packedAt: packed ? new Date() : null },
        $push: { history: { ...actor, at: new Date(), action: packed ? 'packed' : 'unpacked', meta: { revision } } },
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
