'use strict';

/**
 * Session coverage audit — the invariant that keeps ordered goods from vanishing.
 *
 * For every LIVE item of a session's orders (not packed, not cancelled, not
 * skipped) exactly one of two things must be true:
 *   1. it is terminal (packed / cancelled / skipped), or
 *   2. it is represented in exactly one active PickingTask.
 *
 * Nothing enforced that before. `taskBuilder` silently `continue`s past an item
 * whose product has no block position, was archived, or no longer exists, and
 * swallows insertMany failures — so the item quietly received no task at all.
 * `maybeCompleteSession` then declared the session finished because it only ever
 * counted PickingTasks, never the orders those tasks were supposed to cover.
 * Result: session `completed`, order `in_progress`, item neither packed nor
 * cancelled, no task anywhere. A lost product.
 *
 * This module finds those gaps and resolves them.
 */

const Order       = require('../models/Order');
const Product     = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const DeliveryGroup = require('../models/DeliveryGroup');
const mongoose    = require('mongoose');

const { getShippingBlockPositions } = require('./taskBuilder');
const { archiveProduct, getProductTitle } = require('./archiveProduct');
const { resolveOrderStatusAfterCancel } = require('../utils/orderStatus');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { roundMoney } = require('../utils/money');

/**
 * Why an item could not be turned into picking work. Order matters — the first
 * matching reason is reported, from "no product at all" down to "should have
 * worked but didn't".
 *
 *   product_deleted  — the Product document is gone; only the order line remains
 *   product_archived — product exists but is archived, so taskBuilder skips it
 *   no_block         — product is active but has no position in any block
 *   no_task          — everything looks fine yet no task covers it (a swallowed
 *                      insertMany failure, or a build that never ran)
 */
const GAP_REASONS = ['product_deleted', 'product_archived', 'no_block', 'no_task'];

/**
 * Audit one session's coverage.
 *
 * @returns {Promise<{ ok: boolean, gaps: Array }>} gaps grouped by product,
 *          each with the shops waiting on it, ready to render.
 */
async function auditSessionCoverage({ deliveryGroupId, orderingSessionId }) {
  const groupId   = String(deliveryGroupId  || '');
  const sessionId = String(orderingSessionId || '');
  if (!groupId || !sessionId) return { ok: true, gaps: [] };

  const orders = await Order.find(
    {
      'buyerSnapshot.deliveryGroupId': groupId,
      status: { $in: ['new', 'in_progress'] },
      orderingSessionId: sessionId,
    },
    '_id orderNumber buyerSnapshot buyerTelegramId items',
  ).lean();
  if (!orders.length) return { ok: true, gaps: [] };

  const liveItems = [];
  for (const order of orders) {
    for (const item of order.items || []) {
      if (item.packed || item.cancelled || item.skipped) continue;
      liveItems.push({ order, item, productId: item.productId ? String(item.productId) : null });
    }
  }
  if (!liveItems.length) return { ok: true, gaps: [] };

  const productIds = [...new Set(liveItems.map((l) => l.productId).filter(Boolean))];

  const [products, positions, activeTasks] = await Promise.all([
    Product.find({ _id: { $in: productIds } }, '_id status brand model category orderNumber imageUrls localImageUrl').lean(),
    getShippingBlockPositions(productIds),
    PickingTask.find(
      {
        deliveryGroupId: groupId,
        orderingSessionId: sessionId,
        status: { $in: ['pending', 'locked'] },
      },
      'productId items.orderId',
    ).lean(),
  ]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const covered = new Set();
  for (const task of activeTasks) {
    const pid = String(task.productId);
    for (const item of task.items || []) covered.add(`${item.orderId}_${pid}`);
  }

  const byProduct = new Map();
  for (const { order, item, productId } of liveItems) {
    // An item with no productId reference at all is unrepairable data — report it
    // under a synthetic key so it is visible rather than silently dropped.
    const key = productId || `__missing__${order._id}`;
    if (productId && covered.has(`${order._id}_${productId}`)) continue;

    const product = productId ? productMap.get(productId) : null;
    let reason;
    if (!product) reason = 'product_deleted';
    else if (product.status === 'archived') reason = 'product_archived';
    else if (!positions.has(productId)) reason = 'no_block';
    else reason = 'no_task';

    let gap = byProduct.get(key);
    if (!gap) {
      gap = {
        productId: productId || null,
        reason,
        // Present for archived products (the operator should still see WHAT it
        // was); null when the product document is gone — the UI renders its
        // placeholder from that.
        productTitle: product ? getProductTitle(product) : null,
        productOrderNumber: product ? product.orderNumber : null,
        imageUrl: product
          ? ((Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl || null)
          : null,
        shops: [],
        totalQty: 0,
      };
      byProduct.set(key, gap);
    }

    gap.shops.push({
      orderId: String(order._id),
      orderNumber: order.orderNumber ?? null,
      shopName: order.buyerSnapshot?.shopName || 'невідомий магазин',
      shopCity: order.buyerSnapshot?.shopCity || '',
      quantity: item.quantity || 0,
    });
    gap.totalQty += item.quantity || 0;
  }

  const gaps = [...byProduct.values()].sort(
    (a, b) => GAP_REASONS.indexOf(a.reason) - GAP_REASONS.indexOf(b.reason),
  );

  return { ok: gaps.length === 0, gaps };
}

/**
 * Resolve one gap the way the operator asked for: mark the product missing and
 * cancel the positions that were waiting on it.
 *
 * Two shapes, because the product may or may not still exist:
 *   - live product (no_block / no_task) → archiveProduct does the whole job:
 *     cancels the unpacked items, recomputes order totals + status, closes tasks,
 *     archives the product, pulls it out of blocks, notifies the sellers.
 *   - deleted / already-archived product → archiveProduct has nothing to act on,
 *     so cancel the orphaned order lines directly with the same status rules.
 *
 * @returns {Promise<{ cancelledCount: number, archived: boolean }>}
 */
async function resolveCoverageGap({ deliveryGroupId, orderingSessionId, productId, bot = null }) {
  const groupId   = String(deliveryGroupId  || '');
  const sessionId = String(orderingSessionId || '');
  const pid       = productId ? String(productId) : null;
  if (!groupId || !sessionId) {
    throw Object.assign(new Error('Missing group/session'), { code: 'picking_delivery_group_required' });
  }

  if (pid && mongoose.Types.ObjectId.isValid(pid)) {
    const product = await Product.findById(pid);
    if (product && product.status !== 'archived') {
      const { cancelledCount } = await archiveProduct(product, { notifyBuyers: Boolean(bot), bot, reason: 'system_archive' });
      return { cancelledCount, archived: true };
    }
  }

  // Fallback path: no product document (or it is already archived), so only the
  // dangling order lines are left to clean up.
  const schedule = await getOrderingSchedule().catch(() => null);
  const group = await DeliveryGroup.findById(groupId, 'dayOfWeek').lean();
  // Fail-safe mirrors archiveProduct: unknown schedule/group ⇒ treat the window as
  // open ⇒ freeze the status instead of guessing a terminal one.
  const orderingOpenNow = (!schedule || !group)
    ? true
    : isOrderingOpen(group.dayOfWeek, schedule).isOpen;

  const orders = await Order.find({
    'buyerSnapshot.deliveryGroupId': groupId,
    status: { $in: ['new', 'in_progress'] },
    orderingSessionId: sessionId,
  });

  let cancelledCount = 0;
  for (const order of orders) {
    const matching = (order.items || []).filter((i) => {
      if (i.packed || i.cancelled || i.skipped) return false;
      return pid ? String(i.productId) === pid : !i.productId;
    });
    if (!matching.length) continue;

    for (const item of matching) {
      order.totalPrice = Math.max(0, roundMoney(order.totalPrice - (item.price || 0) * (item.quantity || 0)));
      item.cancelled = true;
      cancelledCount += 1;
    }
    order.status = resolveOrderStatusAfterCancel(order, orderingOpenNow);
    await order.save();
  }

  return { cancelledCount, archived: false };
}

module.exports = { auditSessionCoverage, resolveCoverageGap, GAP_REASONS };
