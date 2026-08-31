'use strict';

/**
 * Seller-facing ordering/session read model.
 *
 * This module is deliberately query-only: it may read CURRENT topology,
 * current-session facts and historical presentation, but it never materialises
 * an OrderingSession and never changes Orders/PickingTasks/User/Shop.
 */
const Shop = require('../../models/Shop');
const DeliveryGroup = require('../../models/DeliveryGroup');
const Order = require('../../models/Order');
const PickingTask = require('../../models/PickingTask');
const CatalogReview = require('../../models/CatalogReview');
const OrderingSession = require('../../models/OrderingSession');
const {
  isOrderingOpen,
  getWindowDescription,
  getOrderingWindowOpenAt,
  getSessionDeliveryDate,
} = require('../../utils/orderingSchedule');
const { findCurrentSessionId } = require('../../utils/getOrCreateSession');
const { normalizeDeliveryGroup } = require('../../utils/deliveryGroupHelpers');
const { PHASE_VOCAB } = require('../../utils/sessionVocab');
const { computeSessionPhase } = require('../sessionPresentation');
const { buildShopTransferPayload } = require('../sellerTransferNotice');

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
        const line = { name: item.name || 'Товар', type: 'cancelled', ordered, packed: 0, message: 'Закінчився на складі — не приїде' };
        summary.problemItems.push(line);
        summary.items.push({ ...line, status: 'cancelled', statusLabel: 'Не приїде' });
        continue;
      }
      if (item.skipped) {
        summary.positionsProcessed += 1;
        summary.positionsSkipped += 1;
        summary.unitsNotComing += ordered;
        const line = { name: item.name || 'Товар', type: 'skipped', ordered, packed: 0, message: 'Не потрапив у поточне збирання — не приїде' };
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
          const line = { name: item.name || 'Товар', type: 'short_pick', ordered, packed, message: `Зібрано ${packed} із ${ordered} шт.` };
          summary.problemItems.push(line);
          summary.items.push({ ...line, status: 'short_pick', statusLabel: 'Частково зібрано' });
        } else {
          summary.items.push({ name: item.name || 'Товар', type: 'packed', ordered, packed, message: `Зібрано ${packed} шт.`, status: 'packed', statusLabel: 'Зібрано' });
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

  const [orders, totalTasks, completedTasks, lockedTasks] = await Promise.all([
    Order.find({
      buyerTelegramId: String(user.telegramId),
      orderingSessionId: String(sessionId),
      status: { $ne: 'expired' },
      $or: [{ orderType: 'manual' }, { orderType: { $exists: false } }],
    }).select('orderNumber status createdAt updatedAt items').lean(),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId) }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'completed' }),
    PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'locked' }),
  ]);

  const order = summarizeSellerOrders(orders);
  const pickingStatus = session?.pickingStatus || 'pending';
  const phase = await computeSessionPhase({
    deliveryGroupId: String(group._id),
    sessionId: String(sessionId),
    pickingStatus,
    orderingSchedule: group.orderingSchedule,
  });
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

  const deliveryDate = session?.openDate
    ? getSessionDeliveryDate(session.openDate, group.dayOfWeek, group.orderingSchedule)
    : null;

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
      deliveryDate,
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
      date: deliveryDate,
      dayOfWeek: Number(group.dayOfWeek),
      shopNumber,
      destination: [shop.cityId?.name, shop.address].filter(Boolean).join(', '),
      trackingAvailable: false,
    },
  };
}

function buildTransferPayload(user) {
  return buildShopTransferPayload(user);
}

async function buildSellerOrderingStatusReadModel(user) {
  const transferPayload = buildTransferPayload(user);

  if (user.role === 'warehouse' || (user.role === 'admin' && !user.shopId)) {
    return { isOpen: true, ...transferPayload };
  }
  if (!user.shopId) {
    return {
      isOpen: false,
      reason: 'no_shop',
      message: 'Вас не призначено до жодного магазину. Зверніться до адміністратора.',
      ...transferPayload,
    };
  }

  const shop = await Shop.findById(user.shopId).populate('cityId', 'name').lean();
  if (shop?.isActive === false) {
    return {
      isOpen: false,
      reason: 'shop_inactive',
      message: 'Ваш магазин неактивний. Зверніться до адміністратора.',
      ...transferPayload,
    };
  }
  if (!shop || !shop.deliveryGroupId) {
    return {
      isOpen: false,
      reason: 'shop_no_group',
      message: 'Ваш магазин не прив\'язано до групи доставки. Зверніться до адміністратора.',
      ...transferPayload,
    };
  }

  const group = normalizeDeliveryGroup(await DeliveryGroup.findById(shop.deliveryGroupId).lean());
  if (!group) {
    return {
      isOpen: false,
      reason: 'group_missing',
      message: 'Групу доставки не знайдено. Зверніться до адміністратора.',
      ...transferPayload,
    };
  }

  const status = isOrderingOpen(group.orderingSchedule);
  const window = getWindowDescription(group.orderingSchedule);
  const sessionOpenAt = getOrderingWindowOpenAt(group.orderingSchedule).toISOString();

  // Critical read/write boundary: polling never materialises a weekly cycle.
  let sessionId = null;
  try {
    sessionId = await findCurrentSessionId(String(group._id), group.orderingSchedule);
  } catch (_) {
    sessionId = null;
  }

  let catalogReviewedAt = null;
  try {
    if (sessionId) {
      const mark = await CatalogReview.findOne(
        { sessionId, telegramId: String(user.telegramId) },
        'at',
      ).lean();
      catalogReviewedAt = mark?.at || null;
    }
  } catch (_) {
    catalogReviewedAt = null;
  }

  let closedDashboard = null;
  if (!status.isOpen && sessionId) {
    try {
      closedDashboard = await buildSellerClosedDashboard({
        user,
        shop,
        group,
        sessionId,
        catalogReviewedAt,
      });
    } catch (_) {
      closedDashboard = null;
    }
  }

  return {
    ...status,
    groupName: group.name,
    window,
    sessionOpenAt,
    orderingSessionId: sessionId ? String(sessionId) : '',
    catalogReviewedAt,
    closedDashboard,
    ...transferPayload,
  };
}

module.exports = {
  buildSellerOrderingStatusReadModel,
  buildSellerClosedDashboard,
  buildTransferPayload,
  summarizeSellerOrders,
};
