'use strict';

/**
 * STRICT late-order reconciliation (the only picking-injection policy).
 *
 * Once picking has STARTED for a session (pickingStatus past 'pending'), the
 * pick plan is effectively a frozen snapshot. An order that arrives or changes
 * after that point ("late") is handled per item:
 *
 *   • product still has an OPEN (pending) PickingTask in this group → atomically
 *     ride along: append this shop's item to that task (filter status:'pending';
 *     if it just became locked, we lost the race → skip);
 *   • product task is locked (being picked) / completed (already picked) / there
 *     is no task at all (never in the plan) → mark the order item `skipped`.
 *
 * Strict by design: we NEVER create a brand-new task after the snapshot, so the
 * warehouse never walks back and the session can never hang on an unreachable
 * late task (maybeCompleteSession only ever counts tasks that already existed).
 *
 * Idempotent: re-running sees already-tasked pairs and already-skipped items and
 * does nothing new. Self-guarded: a no-op while the session is still 'pending'
 * (picking not started) — on-time orders are built normally by start-session.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const PickingTask = require('../models/PickingTask');
const OrderingSession = require('../models/OrderingSession');
const { roundMoney } = require('../utils/money');
const { getIO } = require('../socket');

function isTransientTxError(err) {
  const labels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  return (
    err?.code === 112 ||
    err?.codeName === 'WriteConflict' ||
    labels.includes('TransientTransactionError') ||
    err?.hasErrorLabel?.('TransientTransactionError')
  );
}

/**
 * Reconcile a single order against an already-started session (strict).
 * @returns {{ appended:number, skipped:number, statusChanged:boolean, buyerTelegramId?:string }}
 */
async function reconcileLateOrderStrict(orderId, { maxRetries = 3 } = {}) {
  let out = { appended: 0, skipped: 0, statusChanged: false };

  for (let attempt = 0; ; attempt += 1) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) { out = { appended: 0, skipped: 0, statusChanged: false }; return; }
        if (!['new', 'in_progress'].includes(order.status)) { out = { appended: 0, skipped: 0, statusChanged: false }; return; }

        const groupId   = order.buyerSnapshot?.deliveryGroupId ? String(order.buyerSnapshot.deliveryGroupId) : '';
        const sessionId = order.orderingSessionId ? String(order.orderingSessionId) : '';
        if (!groupId || !sessionId) { out = { appended: 0, skipped: 0, statusChanged: false }; return; }

        // GUARD: only act once picking has started. While the session is 'pending'
        // there are no tasks yet — skipping everything here would wipe a normal
        // pre-pick order. start-session builds on-time orders; we never touch those.
        const sess = await OrderingSession.findById(sessionId, 'pickingStatus').session(session).lean();
        if (!sess || sess.pickingStatus === 'pending') { out = { appended: 0, skipped: 0, statusChanged: false }; return; }

        // (orderId,productId) pairs already represented by an active task for this
        // order — those are on-time items, leave them alone.
        const activeTasks = await PickingTask.find(
          { deliveryGroupId: groupId, status: { $in: ['pending', 'locked'] }, 'items.orderId': order._id },
          'productId items.orderId',
        ).session(session).lean();
        const alreadyTasked = new Set();
        for (const t of activeTasks) {
          for (const it of (t.items || [])) alreadyTasked.add(`${it.orderId}_${t.productId}`);
        }

        const buyer = await User.findOne({ telegramId: order.buyerTelegramId }, 'firstName lastName').session(session).lean();
        const sellerName = buyer ? [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') : '';

        let appended = 0;
        let skipped = 0;
        for (const item of order.items) {
          if (item.packed || item.cancelled || item.skipped || !item.productId) continue;
          const pid = String(item.productId);
          if (alreadyTasked.has(`${order._id}_${pid}`)) continue; // on-time, already in a task

          // Ride along ONLY on a still-pending task (atomic). The unique partial
          // index guarantees at most one active task per (product, group), so this
          // matches 0 or 1. A locked/completed/absent task → no match → skip.
          const res = await PickingTask.updateOne(
            { productId: item.productId, deliveryGroupId: groupId, status: 'pending' },
            {
              $addToSet: {
                items: {
                  orderId: order._id,
                  shopName: order.buyerSnapshot?.shopName || 'невідомий магазин',
                  sellerName,
                  orderCreatedAt: order.createdAt || null,
                  quantity: item.quantity || 0,
                  packed: false,
                },
              },
              $set: { orderingSessionId: sessionId },
            },
            { session },
          );

          if ((res.matchedCount ?? res.n ?? 0) > 0) { appended += 1; continue; }

          item.skipped = true;
          skipped += 1;
        }

        if (appended === 0 && skipped === 0) { out = { appended: 0, skipped: 0, statusChanged: false }; return; }

        // Totals exclude skipped (+cancelled): a skipped position is not charged.
        order.totalPrice = roundMoney(
          order.items
            .filter((i) => !i.cancelled && !i.skipped)
            .reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 0), 0),
        );

        let statusChanged = false;
        const noActiveLeft = !order.items.some((i) => !i.cancelled && !i.skipped && !i.packed);
        const anyPacked = order.items.some((i) => i.packed);
        if (skipped > 0 && noActiveLeft && !anyPacked) {
          // Whole order missed this delivery — terminal. Reuse 'cancelled' (in enum,
          // no schema churn); item-level skipped + this history action keep it
          // distinguishable from an out-of-stock cancellation.
          order.status = 'cancelled';
          statusChanged = true;
          order.history.push({ at: new Date(), by: 'system', byName: '', byRole: 'system', action: 'late_skipped_all', meta: { skipped } });
        } else if (skipped > 0) {
          order.history.push({ at: new Date(), by: 'system', byName: '', byRole: 'system', action: 'late_items_skipped', meta: { skipped, appended } });
        }

        await order.save({ session });
        out = { appended, skipped, statusChanged, buyerTelegramId: String(order.buyerTelegramId || '') };
      });
      break;
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    } finally {
      await session.endSession();
    }
  }

  // Surface the change to the seller's order view (badge) — best-effort.
  if ((out.appended || out.skipped) && out.buyerTelegramId) {
    try { getIO().emit('user_order_updated', { buyerTelegramId: out.buyerTelegramId }); } catch { /* socket may be down in tests */ }
  }
  return out;
}

/**
 * Sweep every active order of a started session through the strict reconcile.
 * Called from start-session (warehouse re-opened the picking page).
 */
async function reconcileLateOrdersForSession(deliveryGroupId, orderingSessionId) {
  const groupId = String(deliveryGroupId || '');
  const sessionId = String(orderingSessionId || '');
  if (!groupId || !sessionId) return { appended: 0, skipped: 0, orders: 0 };

  // Cheap pre-filter (lean, no transactions): only orders with an ACTIVE item that
  // has no task yet are "late" and need the transactional per-order reconcile. The
  // overwhelming majority (on-time orders, fully tasked) are skipped here, so a
  // routine picking-page open does not spin up one transaction per order.
  const activeTasks = await PickingTask.find(
    { deliveryGroupId: groupId, status: { $in: ['pending', 'locked'] } },
    'productId items.orderId',
  ).lean();
  const tasked = new Set();
  for (const t of activeTasks) {
    for (const it of (t.items || [])) tasked.add(`${it.orderId}_${t.productId}`);
  }

  const orders = await Order.find(
    { 'buyerSnapshot.deliveryGroupId': groupId, orderingSessionId: sessionId, status: { $in: ['new', 'in_progress'] } },
    '_id items.productId items.packed items.cancelled items.skipped',
  ).lean();

  let appended = 0;
  let skipped = 0;
  let touched = 0;
  for (const o of orders) {
    const hasUntasked = (o.items || []).some(
      (i) => !i.packed && !i.cancelled && !i.skipped && i.productId && !tasked.has(`${o._id}_${i.productId}`),
    );
    if (!hasUntasked) continue;
    touched += 1;
    try {
      const r = await reconcileLateOrderStrict(o._id);
      appended += r.appended;
      skipped += r.skipped;
    } catch (err) {
      console.warn('[lateOrderReconcile] order', String(o._id), 'failed:', err.message);
    }
  }
  return { appended, skipped, orders: touched };
}

module.exports = { reconcileLateOrderStrict, reconcileLateOrdersForSession };
