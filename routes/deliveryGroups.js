const express = require('express');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Shop = require('../models/Shop');
const PickingTask = require('../models/PickingTask');
const CatalogReview = require('../models/CatalogReview');
const OrderingSession = require('../models/OrderingSession');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');
const {
  isOrderingOpen,
  getWindowDescription,
  getOrderingWindowOpenAt,
  getOrderingWindowBoundsForOpenDate,
  getOpenDateWarsaw,
  getSessionDeliveryDate,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { pushSessionEvent } = require('../utils/sessionStatus');
const { openItemArrayFilter } = require('../utils/orderItemState');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { deriveSessionPhase, PHASE_VOCAB } = require('../utils/sessionVocab');
const { getIO } = require('../socket');

const cache = require('../utils/cache');
const { invalidateDeliveryGroup } = require('../utils/modelCache');
const { getTelegramUsernameMap } = require('../utils/telegramUsername');

async function getAllDeliveryGroups() {
  let groups = await cache.get(cache.KEYS.DELIVERY_GROUPS);
  if (!groups) {
    groups = await DeliveryGroup.find().lean();
    await cache.set(cache.KEYS.DELIVERY_GROUPS, groups);
  }
  return groups;
}

const router = express.Router();

function addDaysToOpenDate(openDate, days) {
  const [year, month, day] = String(openDate).split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function summarizeSellerOrders(orders = []) {
  const summary = {
    exists: orders.length > 0,
    orderCount: orders.length,
    orderNumbers: [],
    firstOrderedAt: null,
    lastUpdatedAt: null,
    positionsTotal: 0,
    positionsProcessed: 0,
    positionsPacked: 0,
    positionsPending: 0,
    positionsCancelled: 0,
    positionsSkipped: 0,
    positionsShortfall: 0,
    unitsOrdered: 0,
    unitsPacked: 0,
    unitsPending: 0,
    unitsNotComing: 0,
    shortfallUnits: 0,
    problemItems: [],
    items: [],
  };

  for (const order of orders) {
    if (order.orderNumber != null) summary.orderNumbers.push(order.orderNumber);
    const createdAt = order.createdAt ? new Date(order.createdAt) : null;
    const updatedAt = order.updatedAt ? new Date(order.updatedAt) : null;
    if (createdAt && (!summary.firstOrderedAt || createdAt < summary.firstOrderedAt)) summary.firstOrderedAt = createdAt;
    if (updatedAt && (!summary.lastUpdatedAt || updatedAt > summary.lastUpdatedAt)) summary.lastUpdatedAt = updatedAt;

    for (const item of order.items || []) {
      const ordered = Math.max(0, Number(item.quantity || 0));
      if (!ordered) continue;
      summary.positionsTotal += 1;
      summary.unitsOrdered += ordered;

      if (item.cancelled) {
        summary.positionsProcessed += 1;
        summary.positionsCancelled += 1;
        summary.unitsNotComing += ordered;
        const line = {
          name: item.name || 'Товар',
          type: 'cancelled',
          ordered,
          packed: 0,
          message: 'Закінчився на складі — не приїде',
        };
        summary.problemItems.push(line);
        summary.items.push({ ...line, status: 'cancelled', statusLabel: 'Не приїде' });
        continue;
      }

      if (item.skipped) {
        summary.positionsProcessed += 1;
        summary.positionsSkipped += 1;
        summary.unitsNotComing += ordered;
        const line = {
          name: item.name || 'Товар',
          type: 'skipped',
          ordered,
          packed: 0,
          message: 'Не потрапив у поточне збирання — не приїде',
        };
        summary.problemItems.push(line);
        summary.items.push({ ...line, status: 'skipped', statusLabel: 'Пропущено' });
        continue;
      }

      if (item.packed) {
        const packed = item.packedQuantity == null
          ? ordered
          : Math.max(0, Math.min(ordered, Number(item.packedQuantity || 0)));
        summary.positionsProcessed += 1;
        summary.positionsPacked += 1;
        summary.unitsPacked += packed;
        if (packed < ordered) {
          const missing = ordered - packed;
          summary.positionsShortfall += 1;
          summary.shortfallUnits += missing;
          summary.unitsNotComing += missing;
          const line = {
            name: item.name || 'Товар',
            type: 'short_pick',
            ordered,
            packed,
            message: `Зібрано ${packed} із ${ordered} шт.`,
          };
          summary.problemItems.push(line);
          summary.items.push({ ...line, status: 'short_pick', statusLabel: 'Частково зібрано' });
        } else {
          summary.items.push({
            name: item.name || 'Товар',
            type: 'packed',
            ordered,
            packed,
            message: `Зібрано ${packed} шт.`,
            status: 'packed',
            statusLabel: 'Зібрано',
          });
        }
        continue;
      }

      summary.positionsPending += 1;
      summary.unitsPending += ordered;
      summary.items.push({
        name: item.name || 'Товар',
        type: 'pending',
        ordered,
        packed: 0,
        message: 'Ще не опрацьовано складом',
        status: 'pending',
        statusLabel: 'Очікує',
      });
    }
  }

  summary.orderNumbers = [...new Set(summary.orderNumbers)].sort((a, b) => a - b);
  summary.firstOrderedAt = summary.firstOrderedAt ? summary.firstOrderedAt.toISOString() : null;
  summary.lastUpdatedAt = summary.lastUpdatedAt ? summary.lastUpdatedAt.toISOString() : null;
  return summary;
}

async function buildSellerClosedDashboard({ user, shop, group, sessionId, catalogReviewedAt }) {
  const session = await OrderingSession.findById(
    sessionId,
    'seq openDate pickingStatus pickingConfirmedAt pickingStartedAt pickingCompletedAt shopNumbers',
  ).lean();

  const [orders, groupOrderCount, totalTasks, completedTasks, lockedTasks] = await Promise.all([
    Order.find({
      buyerTelegramId: String(user.telegramId),
      orderingSessionId: String(sessionId),
      status: { $ne: 'expired' },
      $or: [{ orderType: 'manual' }, { orderType: { $exists: false } }],
    }).select('orderNumber status createdAt updatedAt items').lean(),
    Order.countDocuments({ orderingSessionId: String(sessionId), status: { $ne: 'expired' } }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId) }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'completed' }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'locked' }),
  ]);

  const order = summarizeSellerOrders(orders);
  const pickingStatus = session?.pickingStatus || 'pending';
  const hasWork = pickingStatus === 'completed' ? totalTasks > 0 : groupOrderCount > 0;
  const phase = deriveSessionPhase({ pickingStatus, windowOpen: false, hasWork });
  const phaseLabel = PHASE_VOCAB[phase]?.label || 'Очікує';
  const shopNumber = (session?.shopNumbers || []).find((entry) => String(entry.shopId) === String(shop._id))?.number ?? null;
  const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const myProgressPercent = order.positionsTotal > 0
    ? Math.round((order.positionsProcessed / order.positionsTotal) * 100)
    : 0;

  let deliveryStatus = 'none';
  let deliveryStatusLabel = 'У цьому циклі у вас немає замовлення';
  if (order.exists) {
    const myOrderProcessed = order.positionsTotal > 0 && order.positionsProcessed >= order.positionsTotal;
    if (phase === 'awaiting_picking') {
      deliveryStatus = 'waiting_picking';
      deliveryStatusLabel = 'Замовлення прийнято — очікує збирання на складі';
    } else if (phase === 'picking' && myOrderProcessed) {
      deliveryStatus = 'waiting_group';
      deliveryStatusLabel = 'Ваше замовлення вже опрацьовано — очікує завершення збирання всієї групи';
    } else if (phase === 'picking') {
      deliveryStatus = 'picking';
      deliveryStatusLabel = 'Ваше замовлення зараз формують на складі';
    } else if (phase === 'completed') {
      deliveryStatus = 'ready';
      deliveryStatusLabel = 'Склад завершив збирання групи — фактичний виїзд доставки система поки не відстежує';
    } else {
      deliveryStatus = 'accepted';
      deliveryStatusLabel = 'Замовлення прийнято системою';
    }
  }

  return {
    seller: {
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Користувач',
      telegramId: String(user.telegramId || ''),
    },
    shop: {
      id: String(shop._id),
      name: shop.name || '',
      city: shop.cityId?.name || '',
      address: shop.address || '',
    },
    group: {
      id: String(group._id),
      name: group.name || '',
      dayOfWeek: Number(group.dayOfWeek),
    },
    session: {
      id: String(sessionId),
      seq: session?.seq ?? null,
      openDate: session?.openDate ?? null,
      deliveryDate: session?.openDate ? getSessionDeliveryDate(session.openDate, group.dayOfWeek, group.orderingSchedule) : null,
      pickingStatus,
      phase,
      phaseLabel,
      pickingConfirmedAt: session?.pickingConfirmedAt || null,
      pickingStartedAt: session?.pickingStartedAt || null,
      pickingCompletedAt: session?.pickingCompletedAt || null,
      shopNumber,
    },
    order: {
      ...order,
      progressPercent: myProgressPercent,
      catalogReviewedAt: catalogReviewedAt || null,
    },
    warehouse: {
      phase,
      phaseLabel,
      totalTasks,
      completedTasks,
      activeTasks: Math.max(0, totalTasks - completedTasks),
      lockedTasks,
      progressPercent,
    },
    delivery: {
      status: deliveryStatus,
      statusLabel: deliveryStatusLabel,
      date: session?.openDate ? getSessionDeliveryDate(session.openDate, group.dayOfWeek, group.orderingSchedule) : null,
      dayOfWeek: Number(group.dayOfWeek),
      shopNumber,
      destination: [shop.cityId?.name, shop.address].filter(Boolean).join(', '),
      trackingAvailable: false,
    },
  };
}

async function buildDeliveryGroupSessionSummary(group, ordersByGroup) {
  const normalizedGroup = normalizeDeliveryGroup(group);
  const status = isOrderingOpen(normalizedGroup.orderingSchedule);
  const currentSessionId = await getOrCreateSessionId(String(normalizedGroup._id), normalizedGroup.orderingSchedule);
  const sessionOpenAt = getOrderingWindowOpenAt(normalizedGroup.orderingSchedule);
  const orders = ordersByGroup[String(group._id)] || [];
  const summary = orders.reduce(
    (acc, order) => {
      if (order.orderingSessionId === currentSessionId) {
        acc.activeCount += 1;
      } else {
        acc.staleCount += 1;
      }
      return acc;
    },
    { activeCount: 0, staleCount: 0 }
  );

  return {
    groupId: String(normalizedGroup._id),
    groupName: normalizedGroup.name,
    dayOfWeek: normalizedGroup.dayOfWeek,
    isOpen: status.isOpen,
    statusMessage: status.message,
    sessionOpenAt: sessionOpenAt.toISOString(),
    currentSessionId,
    activeCount: summary.activeCount,
    staleCount: summary.staleCount,
  };
}

/**
 * GET /api/delivery-groups/ordering-status
 * Returns ordering window status for the current user's delivery group.
 * Admin/warehouse always get isOpen: true.
 */
router.get('/ordering-status', telegramAuth, async (req, res) => {
  const user = req.telegramUser;

  const transferEvent = Array.isArray(user.history)
    ? [...user.history].reverse().find((entry) =>
        entry.action === 'shop_changed'
        && entry.meta?.fromShop
        && entry.meta?.toShop
        && ['admin', 'warehouse'].includes(entry.byRole)
      )
    : null;
  const transferNote = transferEvent
    ? `Вас переміщено з магазину "${transferEvent.meta.fromShop}" на магазин "${transferEvent.meta.toShop}", ви робите замовлення на інший магазин. Якщо ви нічого не знаєте про це, зверніться до вашого менеджера або в групу в телеграмі!`
    : null;
  const transferNoteId = transferEvent
    ? `shop_changed:${transferEvent.at ? new Date(transferEvent.at).toISOString() : 'unknown'}`
    : null;
  const transferPayload = transferNote ? { note: transferNote, transferNoteId } : {};

  // Warehouse is always unrestricted. Admin without a shopId is also unrestricted.
  // Admin WITH a shopId goes through the same ordering window check as a seller.
  if (user.role === 'warehouse' || (user.role === 'admin' && !user.shopId)) {
    return res.json({ isOpen: true, ...transferPayload });
  }

  // `reason` distinguishes a SETUP problem from a closed ordering window. Both
  // come back as isOpen:false, but they mean completely different things to the
  // user: a closed window opens by itself on schedule, a missing shop never will
  // until an admin acts. Without this the mini-app rendered "Замовлення для
  // групи «» зараз закрито … вас повідомлять, коли вікно відкриється" over an
  // empty group name — a promise nothing would ever keep.
  if (!user.shopId) {
    return res.json({
      isOpen: false,
      reason: 'no_shop',
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const shop = await Shop.findById(user.shopId).populate('cityId', 'name').lean();
  if (!shop || !shop.deliveryGroupId) {
    return res.json({
      isOpen: false,
      reason: 'shop_no_group',
      message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
  if (!group) {
    return res.json({
      isOpen: false,
      reason: 'group_missing',
      message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      ...transferPayload,
    });
  }

  const status = isOrderingOpen(group.orderingSchedule);
  const window = getWindowDescription(group.orderingSchedule);
  const sessionOpenAt = getOrderingWindowOpenAt(group.orderingSchedule).toISOString();

  // "Я переглянув усі товари" — seed the button's state so a seller who already
  // pressed it (possibly on another device) sees the done state, not the button.
  // Best-effort: this is a cosmetic flag, it must never break the ordering window.
  let catalogReviewedAt = null;
  try {
    const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
    const mark = await CatalogReview.findOne(
      { sessionId, telegramId: String(user.telegramId) }, 'at',
    ).lean();
    catalogReviewedAt = mark?.at || null;
  } catch (e) {
    console.warn('[ordering-status] catalog review lookup failed:', e?.message || e);
  }

  let closedDashboard = null;
  if (!status.isOpen) {
    try {
      const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
      closedDashboard = await buildSellerClosedDashboard({
        user,
        shop,
        group,
            sessionId,
        catalogReviewedAt,
      });
    } catch (e) {
      // The enriched closed-screen dashboard is informative, not authorization-
      // critical. A transient aggregation failure must not hide the basic window
      // status; the client has a backward-compatible compact fallback.
      console.warn('[ordering-status] closed dashboard failed:', e?.message || e);
    }
  }

  return res.json({
    ...status,
    groupName: group.name,
    window,
    sessionOpenAt,
    catalogReviewedAt,
    closedDashboard,
    ...transferPayload,
  });
});

/**
 * POST /api/delivery-groups/catalog-reviewed
 * The seller declares they walked the whole catalogue to the end in the CURRENT
 * ordering session. Informational only — nothing downstream gates on it; the
 * warehouse just wants to see who did and who didn't before picking starts.
 *
 * One-way and idempotent: the {sessionId, telegramId} unique index turns a second
 * press into a plain re-read, and there is no endpoint to clear the mark. It ages
 * out by itself when the next session starts (different sessionId).
 */
router.post('/catalog-reviewed', telegramAuth, asyncHandler(async (req, res) => {
  const user = req.telegramUser;
  if (!user.shopId) throw appError('no_shop');

  const shop = await Shop.findById(user.shopId).select('name deliveryGroupId').lean();
  if (!shop || !shop.deliveryGroupId) throw appError('group_not_found');

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
  if (!group) throw appError('group_not_found');

  const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);

  const productCount = Number(req.body?.productCount) || 0;
  const doc = {
    sessionId,
    groupId: String(group._id),
    telegramId: String(user.telegramId),
    userName: [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.telegramId),
    shopId: String(user.shopId),
    shopName: shop.name || '',
    at: new Date(),
    productCount,
  };

  // $setOnInsert only: re-pressing must NOT move the timestamp the warehouse
  // already saw on the board.
  const saved = await CatalogReview.findOneAndUpdate(
    { sessionId, telegramId: doc.telegramId },
    { $setOnInsert: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  // Nudge the picking board so the tick appears without waiting for a poll.
  try {
    const io = getIO();
    if (io) io.to(`picking_group_${String(group._id)}`).emit('shop_status_changed', { groupId: String(group._id) });
  } catch (e) {
    console.warn('[catalog-reviewed] socket emit failed:', e?.message || e);
  }

  res.json({ catalogReviewedAt: saved?.at || doc.at });
}));

router.get('/summary', async (req, res) => {
  const groups = await getAllDeliveryGroups();

  // Кількість активних магазинів по кожній групі
  const shopCounts = await Shop.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
  ]);
  const shopCountMap = Object.fromEntries(shopCounts.map(({ _id, count }) => [String(_id), count]));

  // Кількість продавців по кожній групі (через Shop)
  const sellerCounts = await User.aggregate([
    { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
    { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
    { $unwind: '$shop' },
    { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
  ]);
  const sellerCountMap = Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count]));

  const normalizedGroups = groups.map(normalizeDeliveryGroup);
  const result = normalizedGroups.map((g) => ({
    _id: g._id,
    name: g.name,
    dayOfWeek: g.dayOfWeek,
    shopCount: shopCountMap[String(g._id)] || 0,
    sellerCount: sellerCountMap[String(g._id)] || 0,
  }));
  result.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  res.json(result);
});

/**
 * GET /api/delivery-groups/:groupId/shop-status
 * Returns per-shop cart and ordered item counts for the current ordering session.
 */
router.get('/:groupId/shop-status', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(req.params.groupId).lean());
  if (!group) throw appError('group_not_found');

  const status = isOrderingOpen(group.orderingSchedule);
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);

  const shops = await Shop.find({ deliveryGroupId: String(group._id), isActive: true })
    .select('name cityId')
    .populate('cityId', 'name')
    .lean();

  const shopIds = shops.map((s) => s._id);
  // buyerSnapshot.shopId is stored as ObjectId in some paths and as a String in
  // others — match both forms so direct-add orders (null top-level shopId) are
  // counted. Without this, pre-start showed "0 orders" while the task builder
  // (which keys off buyerSnapshot.deliveryGroupId) still built tasks.
  const shopIdStrs = shopIds.map((id) => String(id));

  const orders = await Order.find({
    $or: [
      { shopId: { $in: shopIds } },
      { 'buyerSnapshot.shopId': { $in: shopIds } },
      { 'buyerSnapshot.shopId': { $in: shopIdStrs } },
    ],
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('buyerSnapshot shopId buyerTelegramId items orderNumber _id createdAt history').lean();

  // Don't report stale orders while the ordering window is still open — during
  // that window the sessionId in DB may differ from currentSessionId (e.g. when a
  // test overrides the schedule), which causes false-positive "stale" warnings.
  const staleOrders = status.isOpen ? [] : await Order.find({
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: { $ne: currentSessionId },
  }).select('buyerSnapshot buyerTelegramId items orderNumber _id createdAt orderingSessionId').lean();

  const sellers = await User.find({ role: { $in: ['seller', 'admin'] }, shopId: { $in: shopIds } })
    .select('shopId firstName lastName telegramId cartState role')
    .lean();
  const contactUsernameMap = await getTelegramUsernameMap([
    ...sellers.map((s) => s.telegramId),
    ...orders.map((o) => o.buyerTelegramId),
    ...staleOrders.map((o) => o.buyerTelegramId),
  ]);
  // Collect ALL sellers per shop with cart status
  const sellersByShop = {};
  for (const seller of sellers) {
    const sid = String(seller.shopId);
    if (!sellersByShop[sid]) sellersByShop[sid] = [];
    const items = seller.cartState?.orderItems;
    const itemObj = items instanceof Map ? Object.fromEntries(items) : (items || {});
    sellersByShop[sid].push({
      name: [seller.firstName, seller.lastName].filter(Boolean).join(' ') || String(seller.telegramId),
      telegramId: String(seller.telegramId),
      username: contactUsernameMap.get(String(seller.telegramId)) || '',
      role: seller.role,
      hasCart: Object.keys(itemObj).length > 0,
    });
  }

  // Build buyer name+role lookup from all unique buyerTelegramIds in orders
  const buyerTgIds = [...new Set([...orders, ...staleOrders].map((o) => o.buyerTelegramId).filter(Boolean))];
  const buyers = await User.find({ telegramId: { $in: buyerTgIds } })
    .select('telegramId firstName lastName role')
    .lean();
  const buyerInfoById = {};
  for (const b of buyers) {
    buyerInfoById[String(b.telegramId)] = {
      name: [b.firstName, b.lastName].filter(Boolean).join(' ') || b.telegramId,
      role: b.role,
      username: contactUsernameMap.get(String(b.telegramId)) || '',
    };
  }

  // Group orders by shopId for conflict detection
  const ordersByShop = {};
  const orderedByShop = {};
  for (const order of orders) {
    const shopId = String(order.shopId || order.buyerSnapshot?.shopId || '');
    if (!shopId) continue;
    if (!ordersByShop[shopId]) ordersByShop[shopId] = [];
    // Flag any order that was ever reassigned to a different shop (regardless of who did it).
    const reassignEntry = (order.history || []).slice().reverse().find((h) => h.action === 'shop_reassigned');
    const wasReassigned = !!reassignEntry;
    ordersByShop[shopId].push({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: order.buyerTelegramId,
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      buyerRole: buyerInfoById[String(order.buyerTelegramId)]?.role || 'seller',
      buyerUsername: buyerInfoById[String(order.buyerTelegramId)]?.username || '',
      itemCount: (order.items || []).filter((i) => !i.cancelled && !i.skipped && !i.voided).length,
      createdAt: order.createdAt,
      wasReassigned,
      fromShopName: wasReassigned ? (reassignEntry?.meta?.from?.shopName || null) : null,
      reassignedByName: wasReassigned ? (reassignEntry?.byName || null) : null,
      reassignedByRole: wasReassigned ? (reassignEntry?.byRole || null) : null,
      reassignedByTelegramId: wasReassigned ? (reassignEntry?.by || null) : null,
      reassignedAt: wasReassigned ? (reassignEntry?.at || null) : null,
    });
    if (!orderedByShop[shopId]) orderedByShop[shopId] = new Set();
    for (const item of order.items || []) {
      if (item.productId && !item.cancelled && !item.skipped && !item.voided) orderedByShop[shopId].add(String(item.productId));
    }
  }

  // Resolve the CANONICAL identity of whoever moved each order here (the
  // "першоджерело" of the conflict) from the users collection — the history
  // byName can be a generic fallback ("Admin"), so prefer the real account.
  const actorIds = new Set();
  for (const list of Object.values(ordersByShop)) {
    for (const o of list) if (o.reassignedByTelegramId) actorIds.add(String(o.reassignedByTelegramId));
  }
  if (actorIds.size > 0) {
    const actors = await User.find({ telegramId: { $in: [...actorIds] } })
      .select('telegramId firstName lastName role').lean();
    const actorById = {};
    for (const a of actors) {
      actorById[String(a.telegramId)] = {
        name: [a.firstName, a.lastName].filter(Boolean).join(' ') || String(a.telegramId),
        role: a.role,
      };
    }
    for (const list of Object.values(ordersByShop)) {
      for (const o of list) {
        const a = o.reassignedByTelegramId && actorById[String(o.reassignedByTelegramId)];
        if (a) {
          o.reassignedByName = a.name;          // canonical First Last
          o.reassignedByRole = a.role;          // canonical role
        }
        // else: keep the history-recorded byName/byRole (actor account deleted)
      }
    }
  }

  // Build per-shop seller cart items map (cartState is now per-user, not per-shop)
  const cartItemsByShop = {};
  for (const seller of sellers) {
    const sid = String(seller.shopId);
    const items = seller.cartState?.orderItems;
    if (!items) continue;
    const itemObj = items instanceof Map ? Object.fromEntries(items) : items;
    cartItemsByShop[sid] = (cartItemsByShop[sid] || 0) + Object.keys(itemObj).length;
  }

  // Build set of telegramIds that placed an order per shop in this session
  const orderedBuyersByShop = {};
  for (const order of orders) {
    const sid = String(order.shopId || '');
    if (!sid || !order.buyerTelegramId) continue;
    if (!orderedBuyersByShop[sid]) orderedBuyersByShop[sid] = new Set();
    orderedBuyersByShop[sid].add(String(order.buyerTelegramId));
  }

  // "Переглянув усі товари" marks of THIS session, keyed by SELLER — one press
  // per person per session (see the model's docblock). Keying on `telegramId|shopId`
  // instead dropped the tick the moment a seller was moved mid-cycle: the row is
  // rendered against their CURRENT shop, so the historical pair never matched again
  // and a seller who did press it showed up as if they had not.
  //
  // WHERE the ticked row is rendered is a different question from WHOSE the tick is.
  // The tick belongs to the person, but staff asked to see "хто на якому магазині
  // натиснув", so a MARKED seller is listed under the SNAPSHOT shop (mark.shopId) —
  // frozen at the press — and NOT under wherever they were moved afterwards. An
  // UNMARKED seller has no snapshot and is listed under their current shop. Exactly
  // one row per person either way: never marked on the old shop AND unmarked on the
  // new one (that would freeze the counter at "1 / 2" for one human).
  const reviewMarks = await CatalogReview.find(
    { groupId: String(group._id), sessionId: currentSessionId }, 'telegramId userName shopId shopName at',
  ).lean();
  const markBySeller = new Map(reviewMarks.map((r) => [String(r.telegramId), r]));
  // Marked sellers who must be RE-HOMED onto their snapshot shop: grouped by that
  // shop, so a person moved away from it (or unassigned entirely) still appears there.
  const markedSellersBySnapshotShop = {};
  const sellerByTelegramId = new Map(sellers.map((s) => [String(s.telegramId), s]));
  // Only shops rendered on this page can host a re-homed row. If the snapshot shop
  // has since left the group or been deactivated there is no row to attach to, so
  // such a mark stays on the seller's current shop — visible beats forensically pure.
  const renderedShopIds = new Set(shopIdStrs);
  for (const mark of reviewMarks) {
    const snapshotShopId = String(mark.shopId || '');
    if (!renderedShopIds.has(snapshotShopId)) continue;   // incl. pre-snapshot marks ('')
    const tgId = String(mark.telegramId);
    const live = sellerByTelegramId.get(tgId);
    if (live && String(live.shopId) === snapshotShopId) continue;  // already in that shop's list
    const items = live?.cartState?.orderItems;
    const itemObj = items instanceof Map ? Object.fromEntries(items) : (items || {});
    if (!markedSellersBySnapshotShop[snapshotShopId]) markedSellersBySnapshotShop[snapshotShopId] = [];
    markedSellersBySnapshotShop[snapshotShopId].push({
      name: live
        ? ([live.firstName, live.lastName].filter(Boolean).join(' ') || tgId)
        : (mark.userName || tgId),
      telegramId: tgId,
      role: live?.role || 'seller',
      hasCart: Object.keys(itemObj).length > 0,
      // The person no longer sits on this shop — the row is here because the press was.
      movedAway: true,
    });
  }

  const shopStatuses = shops.map((shop) => {
    const shopId = String(shop._id);
    const cartItemCount = cartItemsByShop[shopId] || 0;
    const shopOrders = ordersByShop[shopId] || [];
    const uniqueBuyers = new Set(shopOrders.map((o) => o.buyerTelegramId));
    // shopSellerObjs = who is ACTUALLY assigned here right now. The conflict flags
    // below are about assignment, so they keep reading this list, not the display one.
    const shopSellerObjs = sellersByShop[shopId] || [];
    const assignedStaff = shopSellerObjs.filter((s) => s.role === 'seller' || s.role === 'admin');
    const orderedBuyers = orderedBuyersByShop[shopId] || new Set();
    // Display roster: whoever pressed «переглянув усі товари» is listed on the shop
    // they pressed it ON — so drop the ones who pressed on some other shop, and adopt
    // the ones who pressed here and were moved away since. Never both: one row per person.
    const displaySellers = [
      ...shopSellerObjs.filter((s) => {
        const mark = markBySeller.get(String(s.telegramId));
        if (!mark || !renderedShopIds.has(String(mark.shopId || ''))) return true;  // no usable snapshot → stay put
        return String(mark.shopId) === shopId;
      }),
      ...(markedSellersBySnapshotShop[shopId] || []),
    ];
    const sellersWithStatus = displaySellers.map((s) => ({
      ...s,
      hasOrder: orderedBuyers.has(s.telegramId),
      catalogReviewedAt: markBySeller.get(String(s.telegramId))?.at || null,
    }));
    // hasConflict: 2+ separate buyers placed orders in this shop this session
    // hasMultipleSellers: 2+ seller/admin users are assigned to this shop.
    // hasSellerOrderMismatch: multiple assigned users but only some placed orders.
    const hasMultipleSellers = assignedStaff.length > 1;
    const sellersWithOrder = assignedStaff.filter((s) => orderedBuyers.has(s.telegramId));
    const hasSellerOrderMismatch = hasMultipleSellers && shopOrders.length > 0 && sellersWithOrder.length !== assignedStaff.length;
    return {
      shopId,
      shopName: shop.name,
      shopCity: shop.cityId?.name || '',
      sellers: sellersWithStatus,
      sellerName: sellersWithStatus.length > 0 ? sellersWithStatus.map((s) => s.name).join(', ') : null,
      sellerCount: sellersWithStatus.length,
      cartItemCount,
      orderedItemCount: orderedByShop[shopId]?.size || 0,
      orders: shopOrders,
      hasConflict: uniqueBuyers.size > 1,
      hasMultipleSellers,
      hasSellerOrderMismatch,
    };
  });

  // Sort by the shop's EARLIEST order creation time (oldest first) — same ordering
  // as the packing card, so a shop appears in the same relative position on both
  // screens. Shops with no orders this session sort to the bottom, by name.
  const earliestOrderAt = (shop) => {
    const times = (shop.orders || [])
      .map((o) => (o.createdAt ? new Date(o.createdAt).getTime() : null))
      .filter((t) => t !== null);
    return times.length ? Math.min(...times) : Infinity;
  };
  shopStatuses.sort((a, b) => {
    const ta = earliestOrderAt(a);
    const tb = earliestOrderAt(b);
    if (ta !== tb) return ta - tb;
    return String(a.shopName || '').localeCompare(String(b.shopName || ''), 'uk');
  });

  res.json({
    groupId: String(group._id),
    groupName: group.name,
    isOpen: status.isOpen,
    currentSessionId,
    viewerRole: req.telegramUser?.role || '',
    staleOrderCount: staleOrders.length,
    staleOrders: staleOrders.map((order) => ({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      buyerTelegramId: String(order.buyerTelegramId || ''),
      buyerName: buyerInfoById[String(order.buyerTelegramId)]?.name || order.buyerTelegramId,
      buyerUsername: buyerInfoById[String(order.buyerTelegramId)]?.username || '',
      shopName: order.buyerSnapshot?.shopName || '—',
      shopCity: order.buyerSnapshot?.shopCity || '',
      itemCount: (order.items || []).filter((i) => !i.cancelled && !i.skipped && !i.voided).length,
      orderingSessionId: order.orderingSessionId || '',
      createdAt: order.createdAt,
    })),
    shops: shopStatuses,
  });
}));


/**
 * GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products
 * Lazy picking-board disclosure: return ONLY the distinct products currently
 * counted as ordered for this shop in the CURRENT ordering session.
 *
 * Intentionally separate from /shop-status so the normal board stays cheap:
 * product documents/photos are fetched only after staff expands one shop row.
 */
router.get('/:groupId/shops/:shopId/ordered-products', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const limit = Math.min(48, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(req.params.groupId).lean());
  if (!group) throw appError('group_not_found');

  const shop = await Shop.findOne({
    _id: req.params.shopId,
    deliveryGroupId: String(group._id),
    isActive: true,
  }).select('_id').lean();
  if (!shop) throw appError('shop_not_found');

  const currentSessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
  const shopObjectId = shop._id;
  const shopId = String(shop._id);

  // Mirror /shop-status exactly: only active current-session positions that are
  // neither warehouse-cancelled nor strict-late skipped count as "Замовлено".
  const orders = await Order.find({
    $or: [
      { shopId: shopObjectId },
      { 'buyerSnapshot.shopId': shopObjectId },
      { 'buyerSnapshot.shopId': shopId },
    ],
    orderingSessionId: currentSessionId,
    status: { $in: ['new', 'in_progress'] },
  }).select('items').lean();

  const productIds = [];
  const seen = new Set();
  for (const order of orders) {
    for (const item of order.items || []) {
      if (!item.productId || item.cancelled || item.skipped || item.voided) continue;
      const id = String(item.productId);
      if (seen.has(id)) continue;
      seen.add(id);
      productIds.push(item.productId);
    }
  }

  if (productIds.length === 0) {
    return res.json({ items: [], total: 0, limit, offset, hasMore: false });
  }

  const productFilter = { _id: { $in: productIds } };
  const [total, products] = await Promise.all([
    Product.countDocuments(productFilter),
    Product.find(productFilter)
      .select('name brand model category imageUrls originalImageUrl localImageUrl orderNumber status')
      .sort({ orderNumber: 1, _id: 1 })
      .skip(offset)
      .limit(limit)
      .lean(),
  ]);

  res.json({
    items: products.map((product) => ({
      _id: product._id,
      name: product.name || product.brand || product.model || product.category || '',
      imageUrls: product.imageUrls || [],
      originalImageUrl: product.originalImageUrl || '',
      localImageUrl: product.localImageUrl || '',
      status: product.status || '',
    })),
    total,
    limit,
    offset,
    hasMore: offset + products.length < total,
  });
}));

router.get('/session-summaries', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const groups = await getAllDeliveryGroups();
  const groupIds = groups.map((group) => String(group._id));

  const orders = await Order.find({
    'buyerSnapshot.deliveryGroupId': { $in: groupIds },
    status: { $in: ['new', 'in_progress'] },
  })
    .select('buyerSnapshot.deliveryGroupId orderingSessionId')
    .lean();

  const ordersByGroup = orders.reduce((acc, order) => {
    const groupId = String(order.buyerSnapshot.deliveryGroupId || '');
    if (!groupId) return acc;
    if (!acc[groupId]) acc[groupId] = [];
    acc[groupId].push(order);
    return acc;
  }, {});

  const summaries = await Promise.all(groups.map((group) => buildDeliveryGroupSessionSummary(group, ordersByGroup)));
  summaries.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.groupName || '').localeCompare(String(b.groupName || ''));
  });
  res.json(summaries);
});

router.post('/:id/close-ordering-session', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id).lean();
  if (!group) throw appError('group_not_found');

  const admin = req.telegramUser || {};
  const adminActor = {
    by: String(admin.telegramId || ''),
    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
  };

  const status = isOrderingOpen(group.orderingSchedule);
  const currentSessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);

  // HARD RULE: once the warehouse has taken an order into the picking pipeline
  // (PickingTask pending/locked/completed) it is being physically packed. You
  // must NOT expire it just because the ordering session is being moved/closed —
  // that would silently lose a real, packed order. Exclude every such order.
  const pipelineTasks = await PickingTask.find(
    { status: { $in: ['pending', 'locked', 'completed'] } },
    'items.orderId',
  ).lean();
  const protectedOrderIds = [];
  for (const t of pipelineTasks) {
    for (const it of t.items || []) {
      if (it.orderId) protectedOrderIds.push(it.orderId);
    }
  }

  // This endpoint is a HISTORICAL cleanup tool, not a way to close today's
  // picking cycle. Old orders may be expired/parked, but the current session is
  // owned exclusively by its own closure lifecycle (coverage + picking tasks).
  // Therefore currentSessionId is ALWAYS excluded, regardless of whether the
  // ordering window is open or closed. This prevents an admin cleanup from
  // expiring a current coverage-gap order simply because it had no PickingTask yet.
  const staleOrderFilter = {
    'buyerSnapshot.deliveryGroupId': String(group._id),
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: { $ne: currentSessionId },
  };
  if (protectedOrderIds.length > 0) {
    staleOrderFilter._id = { $nin: protectedOrderIds };
  }

  // Transaction so a double-click / concurrent close cannot double-process.
  let expiredCount = 0;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const expiredAt = new Date();
      const result = await Order.updateMany(
        staleOrderFilter,
        {
          $set: {
            status: 'expired',
            'items.$[open].voided': true,
            'items.$[open].voidReason': 'order_expired',
            'items.$[open].voidedAt': expiredAt,
          },
        },
        { session, arrayFilters: [openItemArrayFilter('open')] },
      );
      expiredCount = result.modifiedCount ?? result.nModified ?? 0;
    });
  } finally {
    session.endSession();
  }

  // Log "Закінчилась" on the session timeline — but only when the window for
  // THIS session is actually closing. If the admin clicks "close" while the
  // window is still open (intent = "just clean up stale orders from a previous
  // cycle"), we'd otherwise stamp the current cycle's session with a misleading
  // window-closed event even though its window remains open.
  if (!status.isOpen) {
    try {
      await pushSessionEvent(currentSessionId, {
        type: 'window_closed',
        ...adminActor,
        meta: { expiredCount },
      });
    } catch (e) {
      console.warn('[deliveryGroups/close-ordering-session] event push failed:', e.message);
    }
  }

  res.json({
    message: expiredCount > 0
      ? `Старі замовлення з попередньої сесії закрито: ${expiredCount}.`
      : 'Старих замовлень для закриття не знайдено.',
    expiredCount,
  });
}));

router.get('/', async (req, res) => {
  const groups = await getAllDeliveryGroups();
  const normalizedGroups = groups.map(normalizeDeliveryGroup);
  normalizedGroups.sort((a, b) => {
    const orderA = a.dayOfWeek === 0 ? 7 : a.dayOfWeek;
    const orderB = b.dayOfWeek === 0 ? 7 : b.dayOfWeek;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  // Flag groups whose ordering session is currently CLOSED but still have active orders.
  // This covers any case — seller switched shop, admin moved order, whatever.
  // Orders in an OPEN session are resolved (normal or conflict), no badge needed.
  const closedGroupIds = [];
  for (const g of normalizedGroups) {
    const { isOpen } = isOrderingOpen(g.orderingSchedule);
    if (!isOpen) {
      closedGroupIds.push(String(g._id));
    }
  }
  const problematicByGroup = {};
  if (closedGroupIds.length > 0) {
    const ordersInClosedGroups = await Order.find({
      'buyerSnapshot.deliveryGroupId': { $in: closedGroupIds },
      status: { $in: ['new', 'in_progress'] },
    }).select('buyerSnapshot.deliveryGroupId').lean();
    for (const order of ordersInClosedGroups) {
      const groupId = order?.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '';
      if (groupId) problematicByGroup[groupId] = true;
    }
  }

  const [shopCounts, sellerCounts] = await Promise.all([
    Shop.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
    ]),
    User.aggregate([
      { $match: { role: 'seller', shopId: { $ne: null, $exists: true } } },
      { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
      { $unwind: '$shop' },
      { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
    ]),
  ]);
  const shopCountMap = Object.fromEntries(shopCounts.map(({ _id, count }) => [String(_id), count]));
  const sellerCountMap = Object.fromEntries(sellerCounts.map(({ _id, count }) => [String(_id), count]));

  const result = normalizedGroups.map((g) => ({
    ...g,
    isOpen: isOrderingOpen(g.orderingSchedule).isOpen,
    shopCount: shopCountMap[String(g._id)] || 0,
    sellerCount: sellerCountMap[String(g._id)] || 0,
    hasRelocatedOrders: !!problematicByGroup[String(g._id)],
  }));
  res.json(result);
});

router.post('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { name, dayOfWeek, orderingSchedule } = req.body;
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || dayOfWeek === undefined || !orderingSchedule) {
    throw appError('group_name_or_day_required');
  }
  let normalizedSchedule;
  try { normalizedSchedule = validateOrderingScheduleDeliveryDay(orderingSchedule, dayOfWeek); }
  catch (err) { throw appError('group_schedule_invalid', { reason: err.message }); }

  const group = new DeliveryGroup({ name: trimmedName, dayOfWeek, orderingSchedule: normalizedSchedule });
  await group.save();
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  await invalidateDeliveryGroup(group._id);
  res.status(201).json(group);
}));

router.patch('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) throw appError('group_not_found');

  const admin = req.telegramUser || {};
  const adminActor = {
    by: String(admin.telegramId || ''),
    byName: [admin.firstName, admin.lastName].filter(Boolean).join(' '),
  };

  const { name, dayOfWeek, orderingSchedule } = req.body;
  const oldDayOfWeek = Number(group.dayOfWeek);
  const requestedDayOfWeek = dayOfWeek !== undefined ? Number(dayOfWeek) : oldDayOfWeek;
  const currentSchedule = normalizeOrderingSchedule(
    group.orderingSchedule?.toObject ? group.orderingSchedule.toObject() : group.orderingSchedule,
  );
  let requestedSchedule;
  try {
    requestedSchedule = validateOrderingScheduleDeliveryDay(
      orderingSchedule !== undefined ? orderingSchedule : currentSchedule,
      requestedDayOfWeek,
    );
  } catch (err) {
    throw appError('group_schedule_invalid', { reason: err.message });
  }
  const scheduleIsChanging = JSON.stringify(requestedSchedule) !== JSON.stringify(currentSchedule);
  const dayIsChanging = requestedDayOfWeek !== oldDayOfWeek;
  const timingIsChanging = dayIsChanging || scheduleIsChanging;

  let oldSessionId = null;
  let emptyTargetSession = null;
  if (timingIsChanging) {
    const groupIdStr = String(group._id);
    const currentSessionId = await getOrCreateSessionId(groupIdStr, currentSchedule);
    const currentOpenDate = getOpenDateWarsaw(currentSchedule);
    const nextOpenDate = addDaysToOpenDate(currentOpenDate, 7);
    const nextSession = await OrderingSession.findOne(
      { groupId: groupIdStr, openDate: nextOpenDate },
      '_id pickingStatus openNotifiedAt',
    ).lean();
    const protectedSessionIds = [currentSessionId, nextSession?._id ? String(nextSession._id) : null].filter(Boolean);

    // Clock-time alone must not freeze an empty TEST/configuration group.
    // We block only when changing the calendar could strand REAL session data.
    const [sessionOrder, sessionTask, currentSession] = await Promise.all([
      Order.exists({ orderingSessionId: { $in: protectedSessionIds } }),
      PickingTask.exists({ orderingSessionId: { $in: protectedSessionIds } }),
      OrderingSession.findById(currentSessionId, 'pickingStatus openNotifiedAt').lean(),
    ]);

    const pickingLifecycleActive = currentSession && currentSession.pickingStatus !== 'pending';
    if (sessionOrder || sessionTask || pickingLifecycleActive) {
      const reason = sessionOrder ? 'у поточній або наступній сесії вже є замовлення'
        : sessionTask ? 'у поточній або наступній сесії вже є задачі збирання'
        : 'поточна сесія збирання вже вийшла зі стану pending';
      throw appError('group_day_change_session_active', { reason });
    }

    // A different start weekday can point "current" at another calendar date.
    // Never let a schedule edit accidentally revive an old completed/used
    // OrderingSession as the new current session. Empty pending read-created
    // sessions are safe to discard and will be recreated with a fresh snapshot.
    const requestedOpenDate = getOpenDateWarsaw(requestedSchedule);
    const requestedSession = await OrderingSession.findOne(
      { groupId: groupIdStr, openDate: requestedOpenDate },
      '_id pickingStatus openNotifiedAt',
    ).lean();
    if (requestedSession) {
      const requestedId = String(requestedSession._id);
      const [targetOrderCount, targetTaskCount] = await Promise.all([
        Order.countDocuments({ orderingSessionId: requestedId }),
        PickingTask.countDocuments({ orderingSessionId: requestedId }),
      ]);
      const targetHasWork = targetOrderCount > 0
        || targetTaskCount > 0
        || requestedSession.pickingStatus !== 'pending';
      const targetUsed = targetHasWork || Boolean(requestedSession.openNotifiedAt);

      if (requestedId !== String(currentSessionId) && targetUsed) {
        throw appError('group_day_change_session_active', {
          reason: `новий розклад потрапляє в уже використану сесію ${requestedOpenDate}`,
        });
      }

      // Read-only screens and the open-notification scheduler can materialise an
      // otherwise empty pending session. If there are still no orders/tasks and
      // picking never started, it is safe to refresh its bounds/snapshot. Keep
      // openNotifiedAt intact: a reschedule must never duplicate an already-sent
      // Telegram opening broadcast.
      if (!targetHasWork) {
        emptyTargetSession = { id: requestedId, openDate: requestedOpenDate };
      }
    }

    // Do not reopen an already processed current cycle merely by moving the
    // close boundary forward. New settings then wait naturally for the next
    // weekly start instead of mixing new orders into completed picking.
    if (isOrderingOpen(requestedSchedule).isOpen && currentSession?.pickingStatus === 'completed') {
      throw appError('group_day_change_session_active', {
        reason: 'новий розклад повторно відкрив би вже завершену поточну сесію',
      });
    }

    oldSessionId = currentSessionId;
  }

  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) throw appError('group_name_or_day_required');
    group.name = trimmedName;
  }
  if (dayOfWeek !== undefined) group.dayOfWeek = requestedDayOfWeek;
  if (orderingSchedule !== undefined || dayIsChanging) group.orderingSchedule = requestedSchedule;

  await group.save();

  if (emptyTargetSession) {
    const bounds = getOrderingWindowBoundsForOpenDate(emptyTargetSession.openDate, requestedSchedule);
    await OrderingSession.updateOne(
      { _id: emptyTargetSession.id, pickingStatus: 'pending' },
      {
        $set: {
          openAt: bounds.openAt,
          closeAt: bounds.closeAt,
          scheduleSnapshot: requestedSchedule,
        },
      },
    );
  }

  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  await invalidateDeliveryGroup(group._id);

  if (timingIsChanging && oldSessionId) {
    try {
      await pushSessionEvent(oldSessionId, {
        type: 'rescheduled',
        ...adminActor,
        meta: {
          fromDay: oldDayOfWeek,
          toDay: Number(group.dayOfWeek),
          fromSchedule: currentSchedule,
          toSchedule: requestedSchedule,
        },
      });
    } catch (e) {
      console.warn('[deliveryGroups/PATCH] rescheduled event push failed:', e.message);
    }
  }
  const persistedGroup = await DeliveryGroup.findById(group._id).lean();
  res.json(persistedGroup);
}));

router.delete('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Check + delete in a single transaction so that a magazin or active order
  // created between the count and findByIdAndDelete cannot leave an orphan
  // reference behind.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const group = await DeliveryGroup.findById(req.params.id).session(session);
      if (!group) throw appError('group_not_found');

      const shopCount = await Shop.countDocuments({
        deliveryGroupId: String(group._id),
      }).session(session);
      if (shopCount > 0) throw appError('group_has_shops', { shopCount });

      const activeOrders = await Order.countDocuments({
        'buyerSnapshot.deliveryGroupId': String(group._id),
        status: { $in: ['new', 'in_progress'] },
      }).session(session);
      if (activeOrders > 0) throw appError('group_has_active_orders', { activeOrders });

      // Session history must never become an orphan. Read-only status screens can
      // materialise an EMPTY pending OrderingSession; those are safe to cascade
      // when the group itself is deleted. But once a session has any order/task,
      // catalogue-review mark, sequence number, notification, event or lifecycle
      // progress, it is history and the group deletion is blocked instead of
      // silently severing the reference.
      const groupSessions = await OrderingSession.find(
        { groupId: String(group._id) },
        '_id seq pickingStatus openNotifiedAt events',
      ).session(session).lean();
      const sessionIds = groupSessions.map((row) => String(row._id));
      if (sessionIds.length) {
        const [hasAnyOrder, hasAnyTask, hasAnyCatalogReview] = await Promise.all([
          Order.exists({ orderingSessionId: { $in: sessionIds } }).session(session),
          PickingTask.exists({ orderingSessionId: { $in: sessionIds } }).session(session),
          CatalogReview.exists({ sessionId: { $in: sessionIds } }).session(session),
        ]);
        const hasIntrinsicHistory = groupSessions.some((row) => (
          row.seq != null
          || row.pickingStatus !== 'pending'
          || Boolean(row.openNotifiedAt)
          || (Array.isArray(row.events) && row.events.length > 0)
        ));
        if (hasAnyOrder || hasAnyTask || hasAnyCatalogReview || hasIntrinsicHistory) {
          throw appError('group_has_history', { sessions: groupSessions.length });
        }

        await OrderingSession.deleteMany(
          { _id: { $in: groupSessions.map((row) => row._id) } },
          { session },
        );
      }

      await DeliveryGroup.deleteOne({ _id: group._id }, { session });
      result = { message: 'Групу видалено', _groupId: String(group._id) };
    });
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    if (result?._groupId) {
      await invalidateDeliveryGroup(result._groupId);
      delete result._groupId;
    }
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

/**
 * POST /api/delivery-groups/:id/broadcast
 * Send all active products to all members of the specified delivery group.
 */
/*
router.post('/:id/broadcast', telegramAuth, requireTelegramRole('admin'), async (req, res) => {
  const group = await DeliveryGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  if (!group.members?.length) {
    return res.status(400).json({ error: 'Група не має учасників' });
  }

  try {
    const { startBroadcast } = require('../broadcast');
    const result = await startBroadcast({
      productFilter: { status: 'active' },
      recipientIds: group.members,
      addLabels: true,
    });
    res.json({ message: `Розсилку розпочато для групи "${group.name}"`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
*/

module.exports = router;
