const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Counter = require('../models/Counter');
const Product = require('../models/Product');
const Receipt = require('../models/Receipt');
const User = require('../models/User');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const { roundMoney } = require('../utils/money');
const { getTelegramAuth } = require('../utils/validateTelegramInitData');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');
const { getIO } = require('../socket');
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const OrderingSession = require('../models/OrderingSession');
const { pushSessionEvent } = require('../utils/sessionStatus');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');

// Fire-and-forget: log "Оновлена" on the session timeline only when picking has
// already started. Used by every Order CREATE path (cart submit, restore-stale,
// admin set-item-qty) so the timeline is populated regardless of entry point.
// A failed event push must NEVER abort the order flow — best-effort by design.
function pushOrderAddedEventIfStarted(orderingSessionId, order, actor) {
  if (!orderingSessionId || !order?._id) return;
  OrderingSession.findById(orderingSessionId, 'pickingStatus').lean()
    .then((sess) => {
      if (!sess || sess.pickingStatus === 'pending') return null;
      return pushSessionEvent(orderingSessionId, {
        type: 'order_added',
        by:     String(actor?.by || ''),
        byName: String(actor?.byName || ''),
        meta: { orderId: String(order._id), orderNumber: order.orderNumber },
      });
    })
    .catch((e) => console.warn('[orders] order_added event push failed:', e.message));
}
const { appError, asyncHandler } = require('../utils/errors');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const cache = require('../utils/cache');
const { getShop, getDeliveryGroup, invalidateShop } = require('../utils/modelCache');
const { withLock } = require('../utils/lock');
const { migrateSellerShop } = require('../services/migrateSellerShop');
const { computeTargetShopState } = require('../utils/shopConflict');
const { unassignSellerAndPark } = require('../services/unassignSeller');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');

async function getAllDeliveryGroups() {
  let groups = await cache.get(cache.KEYS.DELIVERY_GROUPS);
  if (!groups) {
    groups = await DeliveryGroup.find().lean();
    await cache.set(cache.KEYS.DELIVERY_GROUPS, groups);
  }
  return groups;
}

const router = express.Router();
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);
const adminOnly = requireTelegramRoles(['admin']);

// Business rule: per ordering session a buyer may order 1..6 units of any one
// product. Because re-ordering OVERWRITES the quantity (set semantics), the
// stored order-item quantity IS the session total for that product, so
// clamping the per-request quantity to [1,6] enforces the session cap.
// Overridable via env without a code change.
const MAX_QTY_PER_PRODUCT = Number(process.env.MAX_QTY_PER_PRODUCT) || 6;

async function getNextOrderNumber() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'orderNumber' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return counter.seq;
}

function actorFromReq(req) {
  const u = req.telegramUser;
  if (!u) return { by: 'system', byName: '', byRole: 'system' };
  return {
    by: String(u.telegramId),
    byName: [u.firstName, u.lastName].filter(Boolean).join(' '),
    byRole: u.role,
  };
}

async function ensureOrderIsStale(order, session = null) {
  const groupId = order?.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '';
  if (!groupId) return;

  const groupQuery = DeliveryGroup.findById(groupId).lean();
  const group = session ? await groupQuery.session(session) : await groupQuery;
  if (!group) return;

  const normalizedGroup = normalizeDeliveryGroup(group);
  const schedule = await getOrderingSchedule();
  const currentSessionId = await getOrCreateSessionId(String(normalizedGroup._id), normalizedGroup.dayOfWeek, schedule);
  if (String(order.orderingSessionId || '') === String(currentSessionId || '')) {
    throw appError('validation_failed', { field: 'orderingSessionId', details: 'order_is_current_session' });
  }
}

async function detachOrderFromPendingTasks(orderId, session) {
  await PickingTask.updateMany(
    { 'items.orderId': orderId, status: { $in: ['pending', 'locked'] } },
    { $pull: { items: { orderId } } },
    { session },
  );

  await PickingTask.deleteMany(
    { status: { $in: ['pending', 'locked'] }, items: { $size: 0 } },
    { session },
  );
}

async function ensureOrderNotInPickingPipeline(orderId, session = null) {
  const query = PickingTask.exists({
    'items.orderId': orderId,
    status: { $in: ['pending', 'locked', 'completed'] },
  });
  const exists = session ? await query.session(session) : await query;
  if (exists) {
    throw appError('order_picking_started');
  }
}

/**
 * Middleware: returns 423 Locked when the ordering window is closed for a seller.
 * Staff (admin / warehouse) always pass through unchanged.
 * Requires telegramAuth to have run first (req.telegramUser populated).
 */
async function requireOrderingWindowOpen(req, res, next) {
  try {
    const user = req.telegramUser;
    // Warehouse users cannot place orders at all — they manage picking, not ordering.
    if (!user || user.role === 'warehouse') return next();
    // Non-sellers (admins) with no shop assigned cannot order — return clear error.
    if (user.role !== 'seller' && !user.shopId) {
      return res.status(403).json({ error: 'no_shop', message: 'Вас не призначено до жодного магазину.' });
    }
    if (user.role !== 'seller') return next(); // admin with shop — skip window check

    if (!user.shopId) {
      return res.status(403).json({
        error: 'no_shop',
        message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      });
    }

    const shop = await Shop.findById(user.shopId).lean();
    if (!shop || !shop.deliveryGroupId) {
      return res.status(403).json({
        error: 'no_delivery_group',
        message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      });
    }

    const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
    if (!group) {
      return res.status(403).json({
        error: 'delivery_group_not_found',
        message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      });
    }

    const schedule = await getOrderingSchedule();
    const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
    if (!isOpen) {
      return res.status(423).json({ error: 'ordering_closed', message });
    }

    next();
  } catch (err) {
    next(err);
  }
}

// POST / has custom registration-check logic so handles its own auth
router.use((req, res, next) => {
  if (req.method === 'POST') return next();
  return telegramAuth(req, res, next);
});

function isProductAvailable(product) {
  return Boolean(product) && product.status !== 'archived';
}

function buildProductLabel(product) {
  return product.brand || product.model || product.category || product.warehouse || `#${product.orderNumber}`;
}

/**
 * GET /conflicts — returns shops with 2+ orders from different sellers in active sessions.
 * Admin and warehouse only.
 */
router.get('/conflicts', staffOnly, async (req, res) => {
  // Collect all active delivery groups with their current sessionId so we can filter
  // only orders that belong to the CURRENT ordering session — stale unresolved orders
  // from previous sessions should not pollute today's picking dashboard.
  const allGroups = (await getAllDeliveryGroups()).map(normalizeDeliveryGroup);
  const schedule = await getOrderingSchedule();

  const sessionIdResults = await Promise.all(
    allGroups.map((group) => getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule)),
  );
  const currentSessionIds = new Set(sessionIdResults.filter(Boolean));

  const sessionFilter = currentSessionIds.size > 0
    ? { orderingSessionId: { $in: [...currentSessionIds] } }
    : {};

  const activeOrders = await Order.find({
    status: { $in: ['new', 'in_progress'] },
    ...sessionFilter,
  }).select('shopId buyerSnapshot buyerTelegramId orderNumber _id createdAt items').lean();

  // Group by shopId
  const byShop = new Map();
  for (const order of activeOrders) {
    const shopId = String(order.shopId || order.buyerSnapshot?.shopId || '');
    if (!shopId) continue;
    if (!byShop.has(shopId)) byShop.set(shopId, []);
    byShop.get(shopId).push(order);
  }

  // Find shops with orders from more than one unique buyer
  const conflictShopIds = [...byShop.entries()]
    .filter(([, orders]) => new Set(orders.map((o) => o.buyerTelegramId)).size > 1)
    .map(([shopId]) => shopId);

  if (conflictShopIds.length === 0) return res.json({ conflicts: [] });

  // Look up shop names
  const shops = await require('../models/Shop').find({ _id: { $in: conflictShopIds } })
    .populate('cityId', 'name')
    .select('name cityId')
    .lean();
  const shopInfoById = {};
  for (const s of shops) {
    shopInfoById[String(s._id)] = { shopName: s.name || '', shopCity: s.cityId?.name || '' };
  }

  // Look up buyer names
  const buyerTgIds = [...new Set(activeOrders.map((o) => o.buyerTelegramId).filter(Boolean))];
  const buyers = await User.find({ telegramId: { $in: buyerTgIds } })
    .select('telegramId firstName lastName')
    .lean();
  const buyerNameById = {};
  for (const b of buyers) {
    buyerNameById[String(b.telegramId)] = [b.firstName, b.lastName].filter(Boolean).join(' ') || b.telegramId;
  }

  const conflicts = conflictShopIds.map((shopId) => {
    const orders = (byShop.get(shopId) || []).map((o) => ({
      orderId: String(o._id),
      orderNumber: o.orderNumber,
      buyerTelegramId: o.buyerTelegramId,
      buyerName: buyerNameById[String(o.buyerTelegramId)] || o.buyerTelegramId,
      itemCount: (o.items || []).filter((i) => !i.cancelled).length,
      createdAt: o.createdAt,
    }));
    return {
      shopId,
      ...shopInfoById[shopId],
      orders,
    };
  });

  res.json({ conflicts });
});

/**
 * POST /conflicts/resolve — admin/warehouse resolves a shop conflict by either
 * moving one seller (with their active order) to a clean shop, or unassigning a
 * seller (parking their not-yet-picked order so it follows them on next assignment).
 * Body: { shopId, buyerTelegramId, action: 'move'|'unassign', toShopId? }
 */
router.post('/conflicts/resolve', staffOnly, asyncHandler(async (req, res) => {
  const actor = req.telegramUser;
  const { shopId, buyerTelegramId, action, toShopId } = req.body || {};

  if (!shopId || !buyerTelegramId || !['move', 'unassign'].includes(action)) {
    throw appError('conflict_resolve_invalid');
  }
  if (action === 'move' && !toShopId) throw appError('conflict_target_required');

  let invalidateFns = [];
  let movedGroups = { prevGroupId: null, newGroupId: null };

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const seller = await User.findOne({ telegramId: String(buyerTelegramId) }).session(session);
      if (!seller) throw appError('conflict_seller_not_found');

      if (action === 'unassign') {
        await unassignSellerAndPark({
          session,
          seller,
          fromShopId: String(shopId),
          actor,
          reason: 'conflict_resolution',
        });
        invalidateFns.push(() => invalidateShop(String(shopId)));
        return;
      }

      // action === 'move'
      const toShop = await Shop.findById(toShopId).populate('cityId', 'name').session(session);
      if (!toShop || !toShop.isActive) throw appError('order_shop_not_found');

      // Target must be completely clean — moving into an occupied shop would just
      // relocate the conflict.
      const targetState = await computeTargetShopState(String(toShop._id), '', session);
      if (targetState.sellers.length > 0 || targetState.activeOrders.length > 0) {
        throw appError('conflict_target_not_empty');
      }

      const result = await migrateSellerShop({
        session,
        existingUser: seller,
        newShopFull: toShop,
        actor,
        reason: 'conflict_resolution_move',
        resetCartItems: false,
        resetCartNavigation: false,
        clearCartReservation: true,
        pushHistory: true,
        updateLastSeller: true,
      });
      movedGroups = { prevGroupId: result.prevGroupId, newGroupId: result.newGroupId };
      if (result.invalidate) invalidateFns.push(result.invalidate);
    });
  } finally {
    session.endSession();
  }

  for (const fn of invalidateFns) {
    try { await fn(); } catch (e) { console.warn('[conflicts resolve] invalidate failed:', e?.message); }
  }

  try {
    const io = getIO();
    if (io) {
      io.emit('user_shop_changed', { telegramId: String(buyerTelegramId) });
      io.emit('user_order_updated', { buyerTelegramId: String(buyerTelegramId) });
      const { prevGroupId, newGroupId } = movedGroups;
      if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
      if (newGroupId && newGroupId !== prevGroupId) {
        io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
      }
    }
  } catch (e) {
    console.warn('[conflicts resolve] socket emit failed:', e?.message);
  }

  res.json({ ok: true });
}));

router.get('/', async (req, res) => {
  const telegramId = req.telegramId;
  const authUser = req.telegramUser;

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const requestedPageSize = req.query.pageSize !== undefined
    ? Math.max(0, Number(req.query.pageSize))
    : 20;
  const MAX_PAGE_SIZE = 200;
  const pageSize = requestedPageSize === 0
    ? MAX_PAGE_SIZE
    : Math.min(MAX_PAGE_SIZE, requestedPageSize);
  const status = req.query.status; // optional: 'new', 'confirmed', 'fulfilled', 'cancelled'
  const buyerTelegramId = req.query.buyerTelegramId;
  const from = req.query.from;
  const to = req.query.to;
  const dateField = req.query.dateField === 'updatedAt' ? 'updatedAt' : 'createdAt';

  const filter = {};
  if (buyerTelegramId) {
    if (String(buyerTelegramId) !== telegramId && !['admin', 'warehouse'].includes(authUser.role)) {
      throw appError('order_query_forbidden');
    }
    filter.buyerTelegramId = String(buyerTelegramId);
  } else if (!['admin', 'warehouse'].includes(authUser.role)) {
    filter.buyerTelegramId = telegramId;
  }

  if (status && status !== 'all') {
    filter.status = status;
  } else if (!status) {
    // By default exclude cancelled
    filter.status = { $ne: 'cancelled' };
  }

  if (req.query.orderType === 'direct_allocation') {
    filter.orderType = 'direct_allocation';
  } else if (req.query.orderType === 'manual') {
    filter.orderType = { $ne: 'direct_allocation' };
  }

  if (from || to) {
    const dateQuery = {};
    if (from) {
      const parsedFrom = new Date(from);
      if (!Number.isNaN(parsedFrom.getTime())) {
        dateQuery.$gte = parsedFrom;
      }
    }
    if (to) {
      const parsedTo = new Date(to);
      if (!Number.isNaN(parsedTo.getTime())) {
        dateQuery.$lt = parsedTo;
      }
    }
    if (Object.keys(dateQuery).length) {
      filter[dateField] = dateQuery;
    }
  }

  const total = await Order.countDocuments(filter);
  const orderQuery = Order.find(filter)
    .populate('items.productId')
    .populate('receiptId', 'receiptNumber')
    .sort({ createdAt: -1 });

  if (pageSize > 0) {
    orderQuery.skip((page - 1) * pageSize).limit(pageSize);
  }

  const orders = await orderQuery;

  const buyerIds = [...new Set(orders.map((o) => o.buyerTelegramId))];
  const buyers = await User.find({ telegramId: { $in: buyerIds } });
  const buyerMap = new Map(buyers.map((buyer) => [buyer.telegramId, buyer]));

  const items = orders.map((order) => {
    const obj = order.toObject();
    obj.receiptNumber = order.receiptId?.receiptNumber || '';
    const buyer = buyerMap.get(order.buyerTelegramId);
    const snap = order.buyerSnapshot;
    obj.buyer = {
      telegramId: order.buyerTelegramId,
      shopName: snap?.shopName ?? '',
      shopAddress: snap?.shopAddress ?? '',
      shopCity: snap?.shopCity ?? '',
      firstName: buyer?.firstName ?? '',
      lastName: buyer?.lastName ?? '',
      phoneNumber: buyer?.phoneNumber ?? '',
    };
    return obj;
  });

  res.json({
    orders: items,
    total,
    page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 1,
  });
});

router.get('/transit/active', staffOnly, async (req, res, next) => {
  try {
    const maxLimit = 200;
    const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || maxLimit));
    const orders = await Order.find({
      orderType: 'direct_allocation',
      status: { $nin: ['fulfilled', 'cancelled'] },
    })
      .populate('items.productId')
      .populate('receiptId', 'receiptNumber')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const buyerIds = [...new Set(orders.map((o) => o.buyerTelegramId))];
    const buyers = await User.find({ telegramId: { $in: buyerIds } }).lean();
    const buyerMap = buyers.reduce((acc, buyer) => ({ ...acc, [buyer.telegramId]: buyer }), {});

    const enrichedOrders = orders.map((o) => {
      const buyer = buyerMap[o.buyerTelegramId] || {};
      const snap = o.buyerSnapshot;
      return {
        ...o,
        buyerDetails: {
          telegramId: o.buyerTelegramId,
          shopName: snap?.shopName ?? '',
          shopAddress: snap?.shopAddress ?? '',
          shopCity: snap?.shopCity ?? '',
          firstName: buyer.firstName ?? '',
          lastName: buyer.lastName ?? '',
          phoneNumber: buyer.phoneNumber ?? '',
        },
        receiptNumber: o.receiptId?.receiptNumber || '',
      };
    });

    res.json(enrichedOrders);
  } catch (error) {
    console.error('[orders.transit.active] Error:', error);
    next(appError('order_transit_failed'));
  }
});

router.post('/:id/fulfill', telegramAuth, staffOnly, async (req, res, next) => {
  try {
    return next(appError('order_status_change_disabled'));
  } catch (error) {
    console.error('[orders.fulfill] Error:', error);
    next(appError('order_fulfill_failed'));
  }
});

router.get('/:id', async (req, res) => {
  const telegramId = req.telegramId;
  const authUser = req.telegramUser;

  const order = await Order.findById(req.params.id).populate('items.productId');
  if (!order) throw appError('order_not_found');
  if (String(order.buyerTelegramId) !== telegramId && !['admin', 'warehouse'].includes(authUser.role)) {
    throw appError('order_view_forbidden');
  }

  const buyer = await User.findOne({ telegramId: order.buyerTelegramId });
  const obj = order.toObject();
  const snap = obj.buyerSnapshot;
  obj.buyer = {
    telegramId: order.buyerTelegramId,
    shopName: snap?.shopName ?? '',
    shopAddress: snap?.shopAddress ?? '',
    shopCity: snap?.shopCity ?? '',
    firstName: buyer?.firstName ?? '',
    lastName: buyer?.lastName ?? '',
    phoneNumber: buyer?.phoneNumber ?? '',
  };
  res.json(obj);
});

router.post('/', asyncHandler(async (req, res) => {
  const { idempotencyKey } = req.body;
  const sanitizedKeyEarly = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;

  // Idempotency: serialise duplicate POSTs on the same key so the second waits
  // for the first commit and returns the existing order, without burning an
  // orderNumber. If no key is supplied, fall back to the old behaviour.
  if (sanitizedKeyEarly) {
    return withLock(`order:idem:${sanitizedKeyEarly}`, async () => {
      const existing = await Order.findOne({ idempotencyKey: sanitizedKeyEarly }).lean();
      if (existing) {
        return res.status(200).json(existing);
      }
      return placeOrderImpl(req, res);
    }, { ttlMs: 30_000, waitMs: 20_000 });
  }
  return placeOrderImpl(req, res);
}));

async function placeOrderImpl(req, res) {
  const { initData, buyerTelegramId, items, shippingAddress, contactInfo, emojiType, idempotencyKey } = req.body;

  // Identity is established by the flexible telegramAuth middleware (initData OR
  // browser JWT). Fall back to re-validating body initData only if it isn't.
  let telegramId = String(req.telegramId || '');
  if (!telegramId) {
    const validation = getTelegramAuth(req, process.env.TELEGRAM_BOT_TOKEN);
    if (!validation.valid || !validation.telegramId) {
      throw appError('order_invalid_initdata');
    }
    telegramId = String(validation.telegramId);
  }

  if (buyerTelegramId && String(buyerTelegramId) !== telegramId) {
    throw appError('order_buyer_mismatch');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw appError('order_items_required');
  }

  const buyer = await User.findOne({ telegramId }).lean();
  if (!buyer) {
    return res.status(403).json({ error: 'not_registered', message: 'Потрібно завершити реєстрацію, перш ніж робити замовлення' });
  }

  const sanitizedKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;

  // Every user must have a shopId to place an order — no shopId means nowhere to deliver.
  // shop, group and schedule are kept in outer scope so the merge logic can use them below
  let shop = null;
  let group = null;
  let schedule = null;
  if (!buyer.shopId) {
    return res.status(403).json({
      error: 'no_shop',
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
    });
  }
  if (buyer.role === 'seller' || buyer.role === 'admin' || buyer.role === 'warehouse') {
    shop = await getShop(buyer.shopId);
    if (!shop || !shop.deliveryGroupId) {
      return res.status(403).json({
        error: 'no_delivery_group',
        message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      });
    }
    group = await getDeliveryGroup(shop.deliveryGroupId);
    if (!group) {
      return res.status(403).json({
        error: 'delivery_group_not_found',
        message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      });
    }
    schedule = await getOrderingSchedule();
    // Seller and admin are bound by the ordering window.
    // Warehouse workers are NOT allowed to place orders at all.
    if (buyer.role === 'warehouse') {
      return res.status(403).json({
        error: 'order_role_forbidden',
        message: 'Працівники складу не можуть робити замовлення.',
      });
    }
    const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
    if (!isOpen) {
      return res.status(423).json({ error: 'ordering_closed', message });
    }

    // Guard: a cart restored from a stale order is pinned to its original delivery
    // group via cartState.reservedForGroupId. Until that reservation is cleared
    // (seller migration with clearCartReservation, or the order placed back into
    // its own group), the items must NOT be submittable to a DIFFERENT group —
    // otherwise the restored order silently lands in the wrong picking session.
    // This invariant was previously enforced only on the client; a direct POST
    // bypassed it. Now enforced server-side.
    const reservedGroupId = buyer.cartState?.reservedForGroupId
      ? String(buyer.cartState.reservedForGroupId)
      : null;
    if (reservedGroupId && reservedGroupId !== String(group._id)) {
      return res.status(409).json({
        error: 'cart_reserved_for_other_group',
        message: 'Кошик зарезервовано для іншої групи доставки. Очистіть кошик або зверніться до адміністратора.',
        reservedForGroupId: reservedGroupId,
      });
    }
  }

  const productIds = items
    .map((item) => item?.productId)
    .filter(Boolean)
    .map(String);

  const realProducts = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(realProducts.map((product) => [String(product._id), product]));

  // Products physically present in a shipping block. A product that exists and is
  // active but sits in NO block (warehouse pulled it back to "надходження", or it
  // is mid-move between blocks) has no floor location and will never get a
  // PickingTask — so it is treated as UNAVAILABLE here, exactly like an archived
  // product: that single item is dropped and the rest of the order goes through.
  // (Previously a not-in-block item returned 422 and rejected the WHOLE order.)
  const inBlockIds = await Block.distinct('productIds', { productIds: { $in: realProducts.map((p) => p._id) } });
  const inBlockSet = new Set(inBlockIds.map(String));

  let totalPrice = 0;
  const validItems = [];
  const archivedItems = []; // items dropped because unavailable (archived OR not in any block)

  for (const item of items) {
    const productId = String(item?.productId || '');
    const product = productMap.get(productId);
    if (!product) continue;
    if (!isProductAvailable(product)) {
      archivedItems.push({
        productId,
        name: buildProductLabel(product),
        reason: 'archived',
      });
      continue;
    }
    // Active but not placed in any block → no picking location, drop like archived.
    if (!inBlockSet.has(String(product._id))) {
      archivedItems.push({
        productId,
        name: buildProductLabel(product),
        reason: 'not_in_block',
      });
      continue;
    }

    const quantity = Math.min(MAX_QTY_PER_PRODUCT, Math.max(1, parseInt(item.quantity, 10) || 1));
    if (quantity <= 0) continue;

    const price = Number(product.price || 0);

    validItems.push({
      productId: product._id,
      name: product.brand || product.model || product.category || `#${product.orderNumber}`,
      price,
      quantity,
      packed: false,
      cancelled: false,
    });

    totalPrice += price * quantity;
  }
  totalPrice = roundMoney(totalPrice);

  if (validItems.length === 0) {
    throw appError('order_no_valid_items');
  }

  // Build existingOrder query: sellers merge per SHOP within the current ordering session.
  // admin/warehouse fall back to a 3-day per-buyer window.
  const existingOrderQuery = {
    status: { $in: ['new', 'in_progress'] },
  };
  let currentSessionId = '';
  if (group && schedule) {
    // All roles with a delivery group: merge within the active ordering session.
    // This includes warehouse, which now also gets orderingSessionId for conflict detection.
    currentSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery['buyerSnapshot.shopId'] = buyer.shopId;
    existingOrderQuery.orderingSessionId = currentSessionId;
  } else {
    // Fallback (e.g. buyer has no delivery group) — use 3-day window per buyer
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    existingOrderQuery.buyerTelegramId = buyer.telegramId;
    existingOrderQuery.createdAt = { $gte: threeDaysAgo };
  }

  // Build buyerSnapshot — reflects the shop at the moment of the order
  const buyerSnapshot = group ? {
    shopId: buyer.shopId || null,
    shopName: shop?.name || '',
    shopCity: shop?.cityId?.name || '',
    shopAddress: shop?.address || '',
    deliveryGroupId: String(group._id),
  } : {
    shopId: buyer.shopId || null,
    shopName: shop?.name || '',
    shopCity: shop?.cityId?.name || '',
    shopAddress: shop?.address || '',
    deliveryGroupId: buyer.deliveryGroupId || '',
  };

  const buyerActor = {
    by: String(buyer.telegramId),
    byName: [buyer.firstName, buyer.lastName].filter(Boolean).join(' '),
    byRole: buyer.role,
  };

  // Serialise create-or-merge for this buyer/shop/session across ALL workers.
  // Without this, two concurrent POSTs with DIFFERENT idempotency keys each
  // find no active order and each insert one → duplicate active orders for the
  // same seller/session (picking then splits the quantities). The MongoDB
  // transaction alone does NOT prevent this — two distinct inserts never
  // write-conflict — but the Redis-backed lock makes the read-modify-write
  // exclusive. (idempotencyKey collisions are still handled below as a backstop.)
  let order;
  const placementLockKey = currentSessionId
    ? `order:place:${buyer.telegramId}:${buyer.shopId || 'none'}:${currentSessionId}`
    : `order:place:${buyer.telegramId}:${buyer.shopId || 'none'}:nogroup`;
  const placement = await withLock(placementLockKey, async () => {
  const mongoSession = await mongoose.connection.startSession();
  try {
    // withTransaction auto-retries on transient WriteConflicts (e.g. a concurrent
    // set-item-qty / remove-item / snapshot writing the same order document) and
    // on UnknownTransactionCommitResult — matching every other order handler.
    // A non-transient error (e.g. 11000 duplicate key) is NOT retried; it aborts
    // and rethrows to the catch below.
    await mongoSession.withTransaction(async () => {
    const txExisting = await Order.findOne(existingOrderQuery).session(mongoSession);

    if (txExisting) {
      for (const newItem of validItems) {
        const sameItem = txExisting.items.find((i) => String(i.productId) === String(newItem.productId));
        if (sameItem) {
          sameItem.quantity = newItem.quantity;
          sameItem.packed = false;
          sameItem.cancelled = false;
        } else {
          txExisting.items.push(newItem);
        }
      }

      // Keep snapshot in sync with current shop data on every merge
      txExisting.buyerTelegramId = buyer.telegramId;
      txExisting.shopId = buyer.shopId || null;
      txExisting.buyerSnapshot = buyerSnapshot;
      if (currentSessionId) txExisting.orderingSessionId = currentSessionId;

      txExisting.totalPrice = roundMoney(txExisting.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0));
      if (txExisting.status === 'new' || txExisting.status === 'in_progress') {
        txExisting.status = 'in_progress';
      }
      txExisting.history.push({
        ...buyerActor,
        action: 'items_merged',
        meta: {
          addedItems: validItems.map((i) => ({ name: i.name, qty: i.quantity })),
          totalItems: txExisting.items.filter((i) => !i.cancelled).length,
        },
      });
      await txExisting.save({ session: mongoSession });
      order = txExisting;
    } else {
      order = new Order({
        buyerTelegramId: buyer.telegramId,
        shopId: buyer.shopId || null,
        items: validItems,
        shippingAddress,
        contactInfo,
        emojiType,
        totalPrice,
        orderingSessionId: currentSessionId,
        buyerSnapshot,
        orderNumber: await getNextOrderNumber(),
        ...(sanitizedKey ? { idempotencyKey: sanitizedKey } : {}),
        history: [{
          ...buyerActor,
          action: 'order_created',
          meta: {
            shopName: buyerSnapshot.shopName,
            shopCity: buyerSnapshot.shopCity,
            itemCount: validItems.length,
          },
        }],
      });
      await order.save({ session: mongoSession });
    }

    // Clear the buyer's cart inside the SAME transaction. Якщо винести цю
    // операцію назовні (як було раніше з .catch warn), отримаємо вікно, у якому
    // замовлення вже існує, але кошик ще «повний» — і клієнт може повторно
    // оформити те саме. Тепер або обидві дії проходять, або жодна.
    {
      const activePositions = (order.items || []).filter((i) => !i.cancelled).length;
      await User.updateOne(
        { telegramId: buyer.telegramId },
        {
          $set: {
            'cartState.lastOrderPositions': activePositions,
            'cartState.orderItems': {},
            'cartState.orderItemIds': [],
            'cartState.updatedAt': new Date(),
          },
        },
        { session: mongoSession },
      );
    }

    });
    return { sentResponse: false };
  } catch (err) {
    // withTransaction has already aborted the transaction. On a non-transient
    // error it rethrows here. A duplicate-key (11000) means a concurrent request
    // already created the active order for this buyer — resolve to the existing one
    // instead of surfacing a 500. Two sources can trigger it:
    //   1. idempotencyKey collision — same client retried with the same key.
    //   2. the one_active_order_per_buyer_shop_session unique index — two requests
    //      with DIFFERENT keys both passed the in-tx "no active order" check and
    //      both inserted; the loser hits the index. This is the DB backstop that
    //      holds even when the Redis placement lock degrades to per-process.
    if (err.code === 11000) {
      if (sanitizedKey) {
        const existing = await Order.findOne({ idempotencyKey: sanitizedKey }).lean();
        if (existing) { res.status(200).json(existing); return { sentResponse: true }; }
      }
      // Fall back to the active-order identity used for merge/uniqueness.
      const existingActive = await Order.findOne(existingOrderQuery).lean();
      if (existingActive) { res.status(200).json(existingActive); return { sentResponse: true }; }
    }
    throw err;
  } finally {
    mongoSession.endSession();
  }
  }, { ttlMs: 30_000, waitMs: 20_000 });

  // The idempotency-collision branch already sent a 200 inside the lock —
  // stop here so we don't fall through to the socket-emit / response code.
  if (placement && placement.sentResponse) return;

  // "Оновлена" on the session timeline (only if picking already started).
  pushOrderAddedEventIfStarted(currentSessionId, order, {
    by: String(buyer.telegramId || ''),
    byName: [buyer.firstName, buyer.lastName].filter(Boolean).join(' '),
  });

  // Save order position count and clear the user's cart (order is placed — cart is done)
  // NOTE: cart-clear is now performed INSIDE the transaction above (atomic with
  // order.save). Тут лише пост-дії: емітимо сокет і повертаємо клієнту явний
  // статус, чи вдалося оповістити підписників — щоб UI не «думав», що все ок,
  // коли real-time оновлення фактично не пройшло.
  let socketDelivered = true;
  let socketError = null;
  try {
    const io = getIO();
    if (io) {
      io.emit('user_order_updated', {
        buyerTelegramId: buyer.telegramId,
        lastOrderAt: order.createdAt,
      });
      // Notify picking-group watchers of new/updated order
      const groupId = order.buyerSnapshot?.deliveryGroupId;
      if (groupId) {
        io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId: String(groupId) });
      }
    } else {
      socketDelivered = false;
      socketError = 'socket_not_initialized';
    }
  } catch (emitError) {
    socketDelivered = false;
    socketError = emitError?.message || String(emitError);
    console.warn('[orders] socket emit failed:', socketError);
  }

  const responseBody = order.toObject ? order.toObject() : order;
  if (archivedItems.length > 0) {
    responseBody.archivedItems = archivedItems;
  }
  // Явний прапорець для UI: якщо socketDelivered === false, клієнту слід
  // явно перепідтягнути стан (refetch), бо real-time оновлення не дійде.
  responseBody._meta = { socketDelivered, ...(socketError ? { socketError } : {}) };

  return res.status(201).json(responseBody);
}

// PATCH /:id/snapshot — admin reassigns order to a different shop
router.patch('/:id/snapshot', staffOnly, async (req, res) => {
  const { shopId } = req.body;
  if (!shopId) throw appError('order_shop_required');

  // Target shop is an immutable reference for this request — safe to load once
  // outside the transaction.
  const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
  if (!shop) throw appError('order_shop_not_found');

  // All writes (Order, PickingTask, User) must commit atomically — partial commits
  // would leave the buyer pointing at one shop while the order points at another,
  // causing phantom conflicts and stale buyerSnapshot data on the next /orders POST.
  //
  // CRITICAL: the order is read INSIDE the transaction (not once up-front). On a
  // WriteConflict, withTransaction re-runs this callback; a closure-captured
  // pre-tx document would carry a stale `items` array, and re-saving it would
  // silently revert a seller's concurrent set-item-qty / remove-item edit that
  // committed in between. Re-reading per attempt makes every retry start from the
  // current document, so the last writer's items survive.
  const session = await mongoose.connection.startSession();
  let order = null;
  let prevGroupId = null;
  let txConflict = null;
  let notActiveStatus = null;
  try {
    await session.withTransaction(async () => {
      // reset per-attempt so a retry recomputes cleanly
      txConflict = null;
      notActiveStatus = null;

      const fresh = await Order.findById(req.params.id).session(session);
      if (!fresh) throw appError('order_not_found');

      // Only allow reassigning active orders — moving fulfilled/cancelled orders
      // would relocate the buyer based on historical data.
      if (!['new', 'in_progress'].includes(fresh.status)) {
        notActiveStatus = fresh.status;
        throw Object.assign(new Error('order_not_active'), { code: 'order_not_active' });
      }

      // Hard guard: once the order is in the picking pipeline, reassignment is forbidden.
      await ensureOrderNotInPickingPipeline(fresh._id, session);

      // Target shop must not already hold someone else's active order — that would
      // create a fresh conflict. Re-checked here (inside the tx) so two concurrent
      // admins can't both pass; only one commits, the other aborts cleanly.
      const conflictInTx = await Order.findOne(
        activeOrderShopFilter(shop._id, { _id: { $ne: fresh._id } }),
      ).session(session).lean();
      if (conflictInTx) {
        txConflict = true;
        // Plain Error → aborts without a TransientTransactionError retry.
        throw Object.assign(new Error('tx_conflict'), { code: 'target_shop_has_order' });
      }

      prevGroupId = fresh.buyerSnapshot?.deliveryGroupId
        ? String(fresh.buyerSnapshot.deliveryGroupId)
        : null;
      const prevSnapshot = fresh.buyerSnapshot
        ? { shopName: fresh.buyerSnapshot.shopName, shopCity: fresh.buyerSnapshot.shopCity }
        : null;

      // Resolve delivery group data once inside the transaction
      let newSessionId = null;
      let warehouseZone = '';
      if (shop.deliveryGroupId) {
        const newGroup = await DeliveryGroup.findById(shop.deliveryGroupId).session(session).lean();
        if (newGroup) {
          const schedule = await getOrderingSchedule();
          newSessionId = await getOrCreateSessionId(String(newGroup._id), newGroup.dayOfWeek, schedule);
          warehouseZone = newGroup.name || '';
        }
      }

      if (!fresh.buyerSnapshot) fresh.buyerSnapshot = {};
      fresh.buyerSnapshot.shopId = String(shop._id);
      fresh.buyerSnapshot.shopName = shop.name || '';
      fresh.buyerSnapshot.shopCity = shop.cityId?.name || '';
      fresh.buyerSnapshot.deliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';
      fresh.shopId = shop._id;
      if (newSessionId) fresh.orderingSessionId = newSessionId;
      fresh.markModified('buyerSnapshot');
      fresh.history.push({
        ...actorFromReq(req),
        action: 'shop_reassigned',
        meta: { from: prevSnapshot, to: { shopName: shop.name || '', shopCity: shop.cityId?.name || '' } },
      });

      await fresh.save({ session });
      order = fresh;

      // Sync shopName in any active PickingTask items that reference this order.
      // Failure here MUST abort the transaction — picking workers would otherwise
      // see a stale shop name on items they're packing.
      await PickingTask.updateMany(
        { 'items.orderId': fresh._id, status: { $in: ['pending', 'locked'] } },
        { $set: { 'items.$[elem].shopName': shop.name || '' } },
        { arrayFilters: [{ 'elem.orderId': fresh._id }], session },
      );

      // Update the buyer: move them to the new shop with the FULL set of derived
      // fields (shopName/shopCity/deliveryGroupId/warehouseZone) so legacy fallbacks
      // never read stale values, and clear their cart since the active order moved.
      if (fresh.buyerTelegramId) {
        const buyerUser = await User.findOne({ telegramId: fresh.buyerTelegramId }).session(session).lean();
        const userUpdate = {
          shopId: shop._id,
          deliveryGroupId: shop.deliveryGroupId ? String(shop.deliveryGroupId) : '',
          'cartState.orderItems': {},
          'cartState.orderItemIds': [],
          'cartState.updatedAt': new Date(),
          'cartState.reservedForGroupId': null,
        };
        if (buyerUser?.role === 'seller') {
          userUpdate.warehouseZone = warehouseZone;
        }
        await User.updateOne(
          { telegramId: fresh.buyerTelegramId },
          { $set: userUpdate },
          { session },
        );
      }
    });
  } catch (err) {
    // order_not_active is a clean 409, not a 500 — surface it as before.
    if (err && err.code === 'order_not_active') {
      return res.status(409).json({
        error: 'order_not_active',
        message: `Замовлення вже ${notActiveStatus === 'fulfilled' ? 'виконано' : 'скасовано'} — перенос неможливий.`,
      });
    }
    // target_shop_has_order is handled via the txConflict flag below; any other
    // error propagates to the central handler.
    if (!(err && err.code === 'target_shop_has_order')) throw err;
  } finally {
    session.endSession();
  }

  if (txConflict) {
    return res.status(409).json({
      error: 'target_shop_has_order',
      message: `Магазин "${shop.name}" вже має активне замовлення. Переніс створить конфлікт. Спочатку вирішіть той конфлікт.`,
    });
  }

  // Notify picking dashboards: both the old group and the new group need to refresh
  try {
    const io = getIO();
    if (io) {
      const newGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : null;
      if (prevGroupId) io.to(`picking_group_${prevGroupId}`).emit('shop_status_changed', { groupId: prevGroupId });
      if (newGroupId && newGroupId !== prevGroupId) io.to(`picking_group_${newGroupId}`).emit('shop_status_changed', { groupId: newGroupId });
      if (order.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: order.buyerTelegramId });
      io.emit('delivery_groups_updated');
    }
  } catch (emitError) {
    console.warn('[orders.snapshot] socket emit failed:', emitError?.message || emitError);
  }

  res.json(order);
});

// POST /:id/stale/restore-to-cart — admin-only action.
// Creates (or updates) an active order for the buyer in the current ordering session
// from the items in the stale order, then expires the stale order.
// No longer writes to cartState.orderItems — items go directly into an Order document.
router.post('/:id/stale/restore-to-cart', telegramAuth, adminOnly, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.connection.startSession();
  let result = null;
  try {
    await mongoSession.withTransaction(async () => {
      const staleOrder = await Order.findById(req.params.id).session(mongoSession);
      if (!staleOrder) throw appError('order_not_found');
      if (!['new', 'in_progress'].includes(staleOrder.status)) {
        throw appError('order_not_active', { status: staleOrder.status });
      }

      await ensureOrderIsStale(staleOrder, mongoSession);
      await ensureOrderNotInPickingPipeline(staleOrder._id, mongoSession);

      const buyerTelegramId = String(staleOrder.buyerTelegramId || '');
      if (!buyerTelegramId) throw appError('validation_failed', { field: 'buyerTelegramId' });

      const buyer = await User.findOne({ telegramId: buyerTelegramId }).session(mongoSession);
      if (!buyer) throw appError('user_not_found');

      const activeItems = (staleOrder.items || []).filter((i) => !i.cancelled && Number(i.quantity) > 0);
      if (activeItems.length === 0) throw appError('validation_failed', { field: 'items' });

      // Resolve current ordering session for the buyer's delivery group.
      const deliveryGroupId = staleOrder.buyerSnapshot?.deliveryGroupId
        ? String(staleOrder.buyerSnapshot.deliveryGroupId)
        : (buyer.deliveryGroupId ? String(buyer.deliveryGroupId) : null);
      if (!deliveryGroupId) throw appError('no_delivery_group');
      const group = normalizeDeliveryGroup(await getDeliveryGroup(deliveryGroupId));
      if (!group) throw appError('delivery_group_not_found');
      const schedule = await getOrderingSchedule();
      const currentSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);

      const actor = actorFromReq(req);

      // Find or create the buyer's active order in the current session.
      let newOrder = await Order.findOne({
        buyerTelegramId,
        orderingSessionId: currentSessionId,
        status: { $in: ['new', 'in_progress'] },
      }).session(mongoSession);

      if (!newOrder) {
        newOrder = new Order({
          orderNumber: await getNextOrderNumber(),
          buyerTelegramId,
          buyerSnapshot: staleOrder.buyerSnapshot,
          orderingSessionId: currentSessionId,
          status: 'new',
          items: activeItems.map((i) => ({
            productId: i.productId,
            name: i.name,
            price: i.price,
            quantity: i.quantity,
            packed: false,
            cancelled: false,
          })),
          totalPrice: roundMoney(activeItems.reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 0), 0)),
          history: [{ ...actor, action: 'created', meta: { restoredFromOrderId: String(staleOrder._id) } }],
        });
      } else {
        // Merge items into existing order — add missing, sum quantities for existing.
        for (const srcItem of activeItems) {
          const pid = String(srcItem.productId);
          const existing = newOrder.items.find((i) => String(i.productId) === pid && !i.cancelled);
          if (existing) {
            existing.quantity += Number(srcItem.quantity);
          } else {
            const cancelled = newOrder.items.find((i) => String(i.productId) === pid && i.cancelled);
            if (cancelled) {
              cancelled.cancelled = false;
              cancelled.quantity = Number(srcItem.quantity);
              cancelled.price = srcItem.price;
            } else {
              newOrder.items.push({ productId: srcItem.productId, name: srcItem.name, price: srcItem.price, quantity: srcItem.quantity, packed: false, cancelled: false });
            }
          }
        }
        newOrder.totalPrice = roundMoney(newOrder.items
          .filter((i) => !i.cancelled)
          .reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 0), 0));
        newOrder.history.push({ ...actor, action: 'items_restored', meta: { restoredFromOrderId: String(staleOrder._id) } });
      }
      await newOrder.save({ session: mongoSession });

      const restoredPositions = newOrder.items.filter((i) => !i.cancelled).length;

      // Update cartState to reflect position count (orderItems remains empty — no cart).
      await User.updateOne(
        { _id: buyer._id },
        { $set: { 'cartState.lastOrderPositions': restoredPositions, 'cartState.orderItems': {}, 'cartState.orderItemIds': [], 'cartState.updatedAt': new Date() } },
        { session: mongoSession },
      );

      await detachOrderFromPendingTasks(staleOrder._id, mongoSession);

      staleOrder.status = 'expired';
      staleOrder.history.push({
        ...actor,
        action: 'stale_order_restored_to_cart',
        meta: { restoredPositions, deliveryGroupId, fromSessionId: staleOrder.orderingSessionId || '', newOrderId: String(newOrder._id) },
      });
      await staleOrder.save({ session: mongoSession });

      await User.updateOne(
        { _id: buyer._id },
        {
          $push: {
            history: {
              at: new Date(),
              ...actor,
              action: 'stale_order_restored_to_cart',
              meta: {
                orderId: String(staleOrder._id),
                orderNumber: staleOrder.orderNumber || null,
                restoredPositions,
                shopName: staleOrder.buyerSnapshot?.shopName || '',
                shopCity: staleOrder.buyerSnapshot?.shopCity || '',
              },
            },
          },
        },
        { session: mongoSession },
      );

      result = {
        orderId: String(staleOrder._id),
        buyerTelegramId,
        deliveryGroupId,
        restoredPositions,
        // Carry the NEW order + session id out of the transaction so the
        // post-commit event push references the destination, not the expired
        // stale doc. Restoring during in-progress picking is exactly the
        // scenario "Оновлена" exists to surface.
        restoredOrderId: String(newOrder._id),
        restoredOrderNumber: newOrder.orderNumber || null,
        currentSessionId,
        actorSnapshot: actor,
      };
    });
  } finally {
    mongoSession.endSession();
  }

  pushOrderAddedEventIfStarted(
    result.currentSessionId,
    { _id: result.restoredOrderId, orderNumber: result.restoredOrderNumber },
    { by: result.actorSnapshot?.by, byName: result.actorSnapshot?.byName },
  );

  try {
    const io = getIO();
    if (io) {
      io.emit('user_order_updated', { buyerTelegramId: result.buyerTelegramId });
      const groupId = result.deliveryGroupId || null;
      if (groupId) io.to(`picking_group_${String(groupId)}`).emit('shop_status_changed', { groupId: String(groupId) });
      io.emit('delivery_groups_updated');
    }
  } catch (emitErr) {
    console.warn('[orders.stale.restore] socket emit failed:', emitErr?.message || emitErr);
  }

  res.json({ message: 'Замовлення відновлено в поточній сесії', ...result });
}));

// POST /:id/stale/expire — admin-only action.
// Expires stale order and detaches it from pending picking tasks.
router.post('/:id/stale/expire', telegramAuth, adminOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) throw appError('order_not_found');
      if (!['new', 'in_progress'].includes(order.status)) {
        throw appError('order_not_active', { status: order.status });
      }

      await ensureOrderIsStale(order, session);
      // An order the warehouse has taken into its pipeline (pending/locked/
      // completed) must NOT be removed by an admin — that decision belongs to
      // the warehouse. Blocks the silent-loss hole where a queued or already
      // packed order could be expired/restored from under the pickers.
      await ensureOrderNotInPickingPipeline(order._id, session);
      await detachOrderFromPendingTasks(order._id, session);

      order.status = 'expired';
      order.history.push({
        ...actorFromReq(req),
        action: 'stale_order_expired_by_admin',
        meta: {
          deliveryGroupId: order.buyerSnapshot?.deliveryGroupId || '',
          fromSessionId: order.orderingSessionId || '',
        },
      });
      await order.save({ session });

      result = {
        orderId: String(order._id),
        buyerTelegramId: String(order.buyerTelegramId || ''),
        deliveryGroupId: order.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '',
      };
    });
  } finally {
    session.endSession();
  }

  try {
    const io = getIO();
    if (io) {
      if (result.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: result.buyerTelegramId });
      if (result.deliveryGroupId) {
        io.to(`picking_group_${result.deliveryGroupId}`).emit('shop_status_changed', { groupId: result.deliveryGroupId });
      }
      io.emit('delivery_groups_updated');
    }
  } catch (emitErr) {
    console.warn('[orders.stale.expire] socket emit failed:', emitErr?.message || emitErr);
  }

  res.json({ message: 'Старе замовлення закрито', ...result });
}));

router.patch('/:id', requireOrderingWindowOpen, async (req, res) => {
  throw appError('order_status_change_disabled');
});

// POST /upsert-item — seller adds, updates, or removes a product in their active session order.
// quantity=0 removes the item. Creates the order if none exists for this session.
// Single endpoint replaces the add-to-cart → place-order two-step flow.
router.post('/upsert-item', telegramAuth, requireOrderingWindowOpen, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const productId = String(req.body?.productId || '').trim();
  const newQty = parseInt(req.body?.quantity, 10);

  if (!productId) throw appError('validation_failed', { field: 'productId' });
  if (!Number.isFinite(newQty) || newQty < 0 || newQty > MAX_QTY_PER_PRODUCT) {
    throw appError('validation_failed', { field: 'quantity' });
  }

  if (!user.shopId) throw appError('no_shop');
  const shop = await getShop(user.shopId);
  if (!shop?.deliveryGroupId) throw appError('no_delivery_group');
  const group = normalizeDeliveryGroup(await getDeliveryGroup(shop.deliveryGroupId));
  if (!group) throw appError('delivery_group_not_found');

  const schedule = await getOrderingSchedule();
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);

  const mongoSession = await mongoose.connection.startSession();
  let result;
  try {
    await mongoSession.withTransaction(async () => {
      const actor = {
        at: new Date(),
        by: String(user.telegramId),
        byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        byRole: user.role,
      };

      let order = await Order.findOne({
        buyerTelegramId: user.telegramId,
        orderingSessionId: currentSessionId,
        status: { $in: ['new', 'in_progress'] },
      }).session(mongoSession);

      if (!order) {
        if (newQty === 0) { result = { ok: true, productId, newQty: 0, action: 'noop' }; return; }

        const product = await Product.findById(productId).session(mongoSession).lean();
        if (!product || !isProductAvailable(product)) throw appError('product_not_found');
        const inBlock = await Block.findOne({ productIds: product._id }).session(mongoSession).lean();
        if (!inBlock) throw appError('product_not_in_block');

        const price = Number(product.price || 0);
        const buyerSnapshot = {
          shopId: String(user.shopId),
          shopName: shop.name || '',
          shopCity: shop.cityId?.name || '',
          shopAddress: shop.address || '',
          deliveryGroupId: String(group._id),
        };
        order = new Order({
          orderNumber: await getNextOrderNumber(),
          buyerTelegramId: user.telegramId,
          // Mirror the cart-submit path (see ~L789): always set the top-level
          // shopId, not just buyerSnapshot.shopId. Leaving it null broke
          // unassignSeller/shop-status (both query by top-level shopId) and
          // caused the "0 orders on pre-start vs N tasks built" desync.
          shopId: user.shopId || null,
          buyerSnapshot,
          orderingSessionId: currentSessionId,
          status: 'new',
          items: [{ productId: product._id, name: buildProductLabel(product), price, quantity: newQty, packed: false, cancelled: false }],
          totalPrice: roundMoney(price * newQty),
          history: [{ ...actor, action: 'created' }],
        });
        await order.save({ session: mongoSession });
        await User.updateOne(
          { telegramId: user.telegramId },
          { $set: { 'cartState.lastOrderPositions': 1, 'cartState.orderItems': {}, 'cartState.orderItemIds': [], 'cartState.updatedAt': new Date() } },
          { session: mongoSession },
        );
        result = { ok: true, productId, newQty, action: 'created', orderId: String(order._id) };
        return;
      }

      // Order exists — find item (including cancelled for re-add)
      const item = order.items.find((i) => String(i.productId) === productId);
      const activeItem = item && !item.cancelled ? item : null;

      if (newQty === 0) {
        if (!activeItem) { result = { ok: true, productId, newQty: 0, action: 'noop' }; return; }
        activeItem.cancelled = true;
        order.history.push({ ...actor, action: 'item_removed', meta: { productId, qty: activeItem.quantity } });
      } else if (!activeItem) {
        // Add new item (or re-add cancelled)
        const product = await Product.findById(productId).session(mongoSession).lean();
        if (!product || !isProductAvailable(product)) throw appError('product_not_found');
        const inBlock = await Block.findOne({ productIds: product._id }).session(mongoSession).lean();
        if (!inBlock) throw appError('product_not_in_block');

        const price = Number(product.price || 0);
        if (item) {
          // Re-activate cancelled item
          item.cancelled = false;
          item.quantity = newQty;
          item.price = price;
          item.packed = false;
        } else {
          order.items.push({ productId: product._id, name: buildProductLabel(product), price, quantity: newQty, packed: false, cancelled: false });
        }
        order.history.push({ ...actor, action: 'item_added', meta: { productId, newQty } });
      } else {
        const oldQty = activeItem.quantity;
        activeItem.quantity = newQty;
        order.history.push({ ...actor, action: 'quantity_adjusted', meta: { productId, oldQty, newQty } });
      }

      order.totalPrice = roundMoney(order.items
        .filter((i) => !i.cancelled)
        .reduce((sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 0), 0));

      await order.save({ session: mongoSession });

      const activePositions = order.items.filter((i) => !i.cancelled).length;
      await User.updateOne(
        { telegramId: user.telegramId },
        { $set: { 'cartState.lastOrderPositions': activePositions, 'cartState.orderItems': {}, 'cartState.orderItemIds': [], 'cartState.updatedAt': new Date() } },
        { session: mongoSession },
      );

      result = { ok: true, productId, newQty, action: newQty === 0 ? 'removed' : (activeItem ? 'updated' : 'added'), orderId: String(order._id) };
    });
  } finally {
    mongoSession.endSession();
  }

  try {
    const io = getIO();
    if (io) {
      io.emit('user_order_updated', { buyerTelegramId: user.telegramId });
      io.to(`picking_group_${String(group._id)}`).emit('shop_status_changed', { groupId: String(group._id) });
    }
  } catch { /* non-critical */ }

  res.json(result);
}));

// POST /set-item-qty — seller sets the exact quantity for a product in their active session order.
// Handles both increase and decrease. Only the buyer themselves can call this.
router.post('/set-item-qty', telegramAuth, requireOrderingWindowOpen, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const productId = String(req.body?.productId || '').trim();
  const newQty = parseInt(req.body?.quantity, 10);

  if (!productId) throw appError('validation_failed', { field: 'productId' });
  if (!Number.isFinite(newQty) || newQty < 1 || newQty > MAX_QTY_PER_PRODUCT) {
    throw appError('validation_failed', { field: 'quantity' });
  }

  if (!user.shopId) throw appError('no_shop');
  const shop = await getShop(user.shopId);
  if (!shop?.deliveryGroupId) throw appError('no_delivery_group');
  const group = normalizeDeliveryGroup(await getDeliveryGroup(shop.deliveryGroupId));
  if (!group) throw appError('delivery_group_not_found');

  const schedule = await getOrderingSchedule();
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);

  // Transaction + re-read inside the session: two concurrent set-item-qty calls
  // on the same order (rapid taps, or different items in parallel) would otherwise
  // last-write-wins on the whole items array and silently lose each other's change.
  // Mongo serializes the writes; session.withTransaction auto-retries on WriteConflict.
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({
        buyerTelegramId: user.telegramId,
        orderingSessionId: currentSessionId,
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (!order) throw appError('order_not_found');

      const item = order.items.find((i) => String(i.productId) === productId && !i.cancelled);
      if (!item) throw appError('order_not_found');

      const oldQty = item.quantity;
      item.quantity = newQty;
      order.totalPrice = roundMoney(order.items
        .filter((i) => !i.cancelled)
        .reduce((sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 0), 0));

      order.history.push({
        at: new Date(),
        by: String(user.telegramId),
        byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        byRole: user.role,
        action: 'quantity_adjusted',
        meta: { productId, oldQty, newQty },
      });

      await order.save({ session });
    });
  } finally {
    session.endSession();
  }
  res.json({ ok: true, productId, newQty });
}));

// POST /remove-item — seller removes (cancels) one product from their active
// session order. Mirrors set-item-qty's lookup/transaction. Buyer-only, and
// only while the ordering window is open. Idempotent: removing an already-
// removed / absent item just returns ok.
router.post('/remove-item', telegramAuth, requireOrderingWindowOpen, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  const productId = String(req.body?.productId || '').trim();
  if (!productId) throw appError('validation_failed', { field: 'productId' });

  if (!user.shopId) throw appError('no_shop');
  const shop = await getShop(user.shopId);
  if (!shop?.deliveryGroupId) throw appError('no_delivery_group');
  const group = normalizeDeliveryGroup(await getDeliveryGroup(shop.deliveryGroupId));
  if (!group) throw appError('delivery_group_not_found');

  const schedule = await getOrderingSchedule();
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.dayOfWeek, schedule);

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({
        buyerTelegramId: user.telegramId,
        orderingSessionId: currentSessionId,
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (!order) throw appError('order_not_found');

      const item = order.items.find((i) => String(i.productId) === productId && !i.cancelled);
      if (!item) {
        // Already gone — idempotent success, nothing to write.
        return;
      }

      const removedQty = item.quantity;
      item.cancelled = true;
      order.totalPrice = roundMoney(order.items
        .filter((i) => !i.cancelled)
        .reduce((sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 0), 0));

      order.history.push({
        at: new Date(),
        by: String(user.telegramId),
        byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        byRole: user.role,
        action: 'item_removed',
        meta: { productId, qty: removedQty },
      });

      await order.save({ session });
    });
  } finally {
    session.endSession();
  }
  res.json({ ok: true, productId, removed: true });
}));

module.exports = router;
