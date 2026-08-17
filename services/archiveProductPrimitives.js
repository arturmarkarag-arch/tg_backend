'use strict';

/**
 * Transaction-aware Product archive/OOS primitive.
 *
 * Owns DB mutations only. It MUST run inside a caller-owned Mongo transaction.
 * Application commands are responsible for commit/retry and all post-commit
 * cache/socket/Telegram/derived-position effects.
 */
const Order = require('../models/Order');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const DeliveryGroup = require('../models/DeliveryGroup');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { resolveOrderStatusAfterCancel } = require('../utils/orderStatus');
const { buildUnreconciledOosTaskFilter } = require('../utils/pickingOosRecovery');
const { detachProductFromAllBlocks } = require('./blockMembershipPrimitives');

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

async function archiveProductInSession(productOrId, {
  session,
  reason = 'manual_archive',
  actor = null,
  now = new Date(),
} = {}) {
  if (!session) throw new Error('archiveProductInSession requires a Mongo session');
  const productId = (productOrId && productOrId._id) ? productOrId._id : productOrId;
  const product = await Product.findById(productId).session(session);
  if (!product) {
    return {
      product: null,
      changed: false,
      alreadyArchived: false,
      cancelledCount: 0,
      orderNotifications: [],
      affectedGroupIds: [],
      affectedSessionIds: [],
      affectedBlockIds: [],
    };
  }

  // Crash-retry compatibility: consume unreconciled OOS signals even when another
  // command already archived the Product. No duplicate external effects follow.
  if (product.status === 'archived') {
    await PickingTask.updateMany(
      buildUnreconciledOosTaskFilter({ productId: product._id }),
      { $set: { archiveReconciled: true } },
      { session },
    );
    return {
      product,
      changed: false,
      alreadyArchived: true,
      cancelledCount: 0,
      orderNotifications: [],
      affectedGroupIds: [],
      affectedSessionIds: [],
      affectedBlockIds: [],
    };
  }

  const orderNotifications = [];
  const affectedGroupIds = new Set();
  const affectedSessionIds = new Set();
  const groupOpenCache = new Map();
  let cancelledCount = 0;

  const isGroupOrderingOpen = async (deliveryGroupId) => {
    const key = String(deliveryGroupId || '');
    if (!key) return false;
    if (groupOpenCache.has(key)) return groupOpenCache.get(key);

    const group = await DeliveryGroup.findById(key, 'orderingSchedule').session(session).lean();
    if (!group) {
      groupOpenCache.set(key, true);
      return true;
    }
    let isOpen = true;
    try { isOpen = isOrderingOpen(group.orderingSchedule, now).isOpen; } catch { isOpen = true; }
    groupOpenCache.set(key, isOpen);
    return isOpen;
  };

  // 1. Reconcile unpacked ordinary OrderItems. Already packed/voided/skipped facts
  // are immutable and remain in their original historical records.
  const activeOrders = await Order.find({
    status: { $in: ['new', 'in_progress'] },
    'items.productId': product._id,
  }).session(session);

  for (const order of activeOrders) {
    const matchingItems = order.items.filter(
      (item) => String(item.productId) === String(product._id)
        && !item.packed && !item.cancelled && !item.skipped && !item.voided,
    );
    if (!matchingItems.length) continue;

    for (const item of matchingItems) {
      order.totalPrice = Math.max(
        0,
        require('../utils/money').roundMoney(order.totalPrice - item.price * item.quantity),
      );
      item.cancelled = true;
      cancelledCount += 1;
    }

    order.history.push({
      at: now,
      by: actor?.by || 'system',
      byName: actor?.byName || '',
      byRole: actor?.byRole || 'system',
      action: reason === 'out_of_stock' ? 'items_out_of_stock' : 'items_cancelled_archive',
      meta: {
        reason,
        productId: String(product._id),
        productTitle: getProductTitle(product),
        cancelled: matchingItems.length,
        quantity: matchingItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
      },
    });

    const orderingOpenNow = await isGroupOrderingOpen(order.buyerSnapshot?.deliveryGroupId);
    order.status = resolveOrderStatusAfterCancel(order, orderingOpenNow);
    await order.save({ session });

    orderNotifications.push({
      orderId: String(order._id),
      buyerTelegramId: order.buyerTelegramId,
    });
    if (order.buyerSnapshot?.deliveryGroupId) {
      affectedGroupIds.add(String(order.buyerSnapshot.deliveryGroupId));
    }
    if (order.orderingSessionId) affectedSessionIds.add(String(order.orderingSessionId));
  }

  // 2. Close open PickingTasks and consume crash-recovery OOS signals.
  const openTasks = await PickingTask.find(
    { productId: product._id, status: { $in: ['pending', 'locked'] } },
    'orderingSessionId',
  ).session(session).lean();
  for (const task of openTasks) {
    if (task.orderingSessionId) affectedSessionIds.add(String(task.orderingSessionId));
  }

  const oosSignals = await PickingTask.find(
    buildUnreconciledOosTaskFilter({ productId: product._id }),
    'orderingSessionId',
  ).session(session).lean();
  for (const task of oosSignals) {
    if (task.orderingSessionId) affectedSessionIds.add(String(task.orderingSessionId));
  }

  if (oosSignals.length) {
    await PickingTask.updateMany(
      { _id: { $in: oosSignals.map((task) => task._id) } },
      { $set: { archiveReconciled: true } },
      { session },
    );
  }

  await PickingTask.updateMany(
    { productId: product._id, status: { $in: ['pending', 'locked'] } },
    {
      $set: {
        status: 'completed',
        completionReason: 'system_archive',
        lockedBy: null,
        lockedAt: null,
        completedExpireAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
    },
    { session },
  );

  // 3. Archive Product CURRENT state.
  const oldOrderNumber = product.orderNumber;
  product.status = 'archived';
  product.archivedAt = now;
  product.archivedBy = String(actor?.by || '');
  product.archivedByName = String(actor?.byName || (reason === 'system_archive' ? 'Система' : ''));
  product.archivedByRole = String(actor?.byRole || (reason === 'system_archive' ? 'system' : ''));
  product.archiveReason = String(reason || 'manual_archive');
  product.originalOrderNumber = oldOrderNumber;
  product.orderNumber = 0;
  await product.save({ session });

  // 4. Physical membership is part of the same transaction.
  const detached = await detachProductFromAllBlocks({ productId: product._id, session });

  return {
    product,
    changed: true,
    alreadyArchived: false,
    cancelledCount,
    orderNotifications,
    affectedGroupIds: [...affectedGroupIds],
    affectedSessionIds: [...affectedSessionIds],
    affectedBlockIds: detached.blockIds || [],
  };
}

module.exports = { archiveProductInSession, getProductTitle };
