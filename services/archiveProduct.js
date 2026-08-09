/**
 * Unified product archive service.
 *
 * Handles full reconciliation for BOTH manual (admin UI) and sold-out (bot /ship) scenarios:
 *  - Cancels unpacked items in active orders and recomputes order status/totalPrice
 *  - Closes pending/locked PickingTasks for this product
 *  - Sets product status → 'archived', preserves originalOrderNumber
 *  - Removes the product from any warehouse blocks and broadcasts block_updated
 *
 * @param {import('../models/Product').default} product  Mongoose document (must be a full doc, not lean)
 * @param {object}  [opts]
 * @param {boolean} [opts.notifyBuyers=false]  Send Telegram message to affected buyers
 * @param {object}  [opts.bot=null]            node-telegram-bot-api instance (required when notifyBuyers=true)
 * @param {string}  [opts.reason='manual_archive']  Why the product is being archived —
 *        'out_of_stock' (picker hit an empty shelf) | 'manual_archive' (staff deleted it)
 *        | 'system_archive' (orphan sweep / coverage repair). Recorded in every
 *        affected order's history so the cancellation is explainable after the fact.
 * @param {object}  [opts.actor=null]          { by, byName, byRole } — who triggered it
 * @returns {Promise<{ cancelledCount: number }>}
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { resolveOrderStatusAfterCancel } = require('../utils/orderStatus');
const { getIO } = require('../socket');
const { buildUnreconciledOosTaskFilter } = require('../utils/pickingOosRecovery');

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

const ARCHIVE_MAX_RETRIES = 3;

// A WriteConflict (code 112) is transient: two transactions touched the same
// docs (e.g. concurrent archives reconciling the same order or block).
// Retrying with a fresh read resolves it.
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
 * Accepts a Product mongoose doc OR a product id. Retry + the fresh per-attempt
 * re-read live INSIDE this function, so every caller (manual delete, out-of-stock,
 * orphan sweep) is protected automatically — no external runOperationWithRetry
 * wrapper needed, and no risk of a stale in-memory doc leaking across attempts.
 */
async function archiveProduct(productOrId, { notifyBuyers = false, bot = null, reason = 'manual_archive', actor = null } = {}) {
  const productId = (productOrId && productOrId._id) ? productOrId._id : productOrId;

  // Captured from the committed attempt; emitted AFTER commit (once).
  let product;
  let orderNotifications = [];
  let affectedGroupIds = new Set();
  let affectedSessionIds = new Set();
  let cancelledCount = 0;
  let affectedBlockIds = [];

  for (let attempt = 0; ; attempt += 1) {
    // Per-attempt accumulators — reset on every retry.
    const attemptNotifications = [];
    const attemptGroupIds = new Set();
    const attemptSessionIds = new Set();
    let attemptCancelled = 0;
    let oldOrderNumber;
    let attemptBlockIds = [];
    const groupOpenCache = new Map();

    const session = await mongoose.connection.startSession();
    session.startTransaction();
    try {
      // Re-read FRESH inside the session each attempt. Idempotent no-op if the
      // product vanished or was already archived by a concurrent path.
      product = await Product.findById(productId).session(session);
      if (!product) {
        await session.abortTransaction();
        return { cancelledCount: 0 }; // finally ends the session
      }

      // Idempotent recovery: the product may already have been archived by the
      // successful phase-2 write while the caller/recovery sweep still sees an
      // unreconciled completed OOS signal. Consuming that signal is part of the
      // archive contract; otherwise `archiveReconciled:false` lives forever and
      // MASS/session diagnostics report a false crash-recovery orphan.
      if (product.status === 'archived') {
        await PickingTask.updateMany(
          buildUnreconciledOosTaskFilter({ productId: product._id }),
          { $set: { archiveReconciled: true } },
          { session },
        );
        await session.commitTransaction();
        return { cancelledCount: 0 }; // no duplicate emits/notifications
      }

      const isGroupOrderingOpen = async (deliveryGroupId) => {
      const key = String(deliveryGroupId || '');
      if (!key) return false;
      if (groupOpenCache.has(key)) return groupOpenCache.get(key);

      const group = await DeliveryGroup.findById(key, 'orderingSchedule').session(session).lean();
      if (!group) {
        groupOpenCache.set(key, true);
        return true;
      }

      // Fail-safe: a corrupted group schedule must freeze order-status finalisation
      // instead of guessing that ordering is closed. Startup preflight should make
      // this unreachable in normal operation, but raw DB edits must not turn OOS
      // reconciliation into a destructive transition.
      let isOpen = true;
      try { isOpen = isOrderingOpen(group.orderingSchedule).isOpen; } catch { isOpen = true; }
      groupOpenCache.set(key, isOpen);
      return isOpen;
    };

    // ── 1. Reconcile active orders ───────────────────────────────────────────
    const activeOrders = await Order.find({
      status: { $in: ['new', 'in_progress'] },
      'items.productId': product._id,
    }).session(session);

    for (const order of activeOrders) {
      const matchingItems = order.items.filter(
        (i) => String(i.productId) === String(product._id) && !i.packed && !i.cancelled && !i.skipped
      );
      if (!matchingItems.length) continue;

      for (const item of matchingItems) {
        order.totalPrice = Math.max(0, require('../utils/money').roundMoney(order.totalPrice - item.price * item.quantity));
        item.cancelled = true;
        attemptCancelled += 1;
      }

      // The ONLY record the seller's side ever gets: nothing is sent over Telegram
      // (notifyBuyers stays false on every live caller — decided with the operator),
      // and the socket badge only lands if their mini-app happens to be open. Without
      // this entry a cancelled position has no explanation anywhere.
      order.history.push({
        at: new Date(),
        by: actor?.by || 'system',
        byName: actor?.byName || '',
        byRole: actor?.byRole || 'system',
        action: reason === 'out_of_stock' ? 'items_out_of_stock' : 'items_cancelled_archive',
        meta: {
          reason,
          productId: String(product._id),
          productTitle: getProductTitle(product),
          cancelled: matchingItems.length,
          quantity: matchingItems.reduce((s, i) => s + (Number(i.quantity) || 0), 0),
        },
      });

      const orderingOpenNow = await isGroupOrderingOpen(order.buyerSnapshot?.deliveryGroupId);
      order.status = resolveOrderStatusAfterCancel(order, orderingOpenNow);

      await order.save({ session });
      attemptNotifications.push({ orderId: String(order._id), buyerTelegramId: order.buyerTelegramId });
      if (order.buyerSnapshot?.deliveryGroupId) {
        attemptGroupIds.add(String(order.buyerSnapshot.deliveryGroupId));
      }
      if (order.orderingSessionId) attemptSessionIds.add(String(order.orderingSessionId));
    }

    // ── 2. Close open PickingTasks ───────────────────────────────────────────
    // Capture their owning sessions BEFORE the update. Session membership is
    // immutable, and every affected session must be re-evaluated after commit.
    const openTasks = await PickingTask.find(
      { productId: product._id, status: { $in: ['pending', 'locked'] } },
      'orderingSessionId',
    ).session(session).lean();
    for (const t of openTasks) if (t.orderingSessionId) attemptSessionIds.add(String(t.orderingSessionId));

    // Crash-retry OOS can have no active OrderItem and no open task anymore: phase 1
    // already completed the task, then the server died before archiveProduct. That
    // completed/out_of_stock task is still an affected-session source.
    const oosSignals = await PickingTask.find(
      buildUnreconciledOosTaskFilter({ productId: product._id }),
      'orderingSessionId',
    ).session(session).lean();
    for (const t of oosSignals) if (t.orderingSessionId) attemptSessionIds.add(String(t.orderingSessionId));

    // Successful product archival CONSUMES the crash-recovery signal in the SAME
    // transaction. This was the missing write behind the MASS failure where all
    // OOS products were archived correctly but 41 completed OOS tasks remained
    // `archiveReconciled:false` forever. Restrict to the snapshot ids we just read
    // so a later concurrent signal cannot be accidentally consumed by this tx.
    if (oosSignals.length) {
      await PickingTask.updateMany(
        { _id: { $in: oosSignals.map((t) => t._id) } },
        { $set: { archiveReconciled: true } },
        { session },
      );
    }

    // completedExpireAt stamps the 90-day TTL so these system-closed tasks are
    // reaped like normal completions (no completedBy — excluded from ranking).
    await PickingTask.updateMany(
      { productId: product._id, status: { $in: ['pending', 'locked'] } },
      { $set: { status: 'completed', completionReason: 'system_archive', lockedBy: null, lockedAt: null, completedExpireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) } },
      { session }
    );

    // ── 3. Archive the product ───────────────────────────────────────────────
    oldOrderNumber = product.orderNumber;
    product.status = 'archived';
    product.archivedAt = new Date();
    product.originalOrderNumber = oldOrderNumber;
    product.orderNumber = 0;
    await product.save({ session });

    // ── 4. Remove from blocks (inside transaction so it's atomic with archive) ──
      const affectedBlocks = await Block.find({ productIds: product._id }, 'blockId').session(session).lean();
      attemptBlockIds = affectedBlocks.map((b) => b.blockId);
      if (attemptBlockIds.length) {
        await Block.updateMany(
          { productIds: product._id },
          { $pull: { productIds: product._id }, $inc: { version: 1 } },
          { session }
        );
      }

      await session.commitTransaction();

      // Promote this attempt's results to the outer scope for post-tx emits.
      cancelledCount     = attemptCancelled;
      orderNotifications = attemptNotifications;
      affectedGroupIds   = attemptGroupIds;
      affectedSessionIds = attemptSessionIds;
      affectedBlockIds   = attemptBlockIds;
      break;
    } catch (err) {
      // Guard the abort: if commitTransaction() itself threw (a WriteConflict at
      // commit time under contention), the transaction is already terminal and an
      // unguarded abortTransaction() throws a SECONDARY MongoTransactionError that
      // MASKS the original transient error — so the retry below never fires and the
      // caller crashes to 500. Swallow the teardown error so the REAL err is judged.
      try { await session.abortTransaction(); } catch { /* already terminal after a failed commit */ }
      // finally runs on both throw and continue, so endSession happens once there.
      if (!isTransientTxError(err) || attempt >= ARCHIVE_MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      continue;
    } finally {
      session.endSession();
    }
  }

  // Re-evaluate EVERY session whose own Orders/Tasks were changed. This is not a
  // cross-session gate: each maybeCompleteSession audits only that session. Old
  // sessions may heal in the background, but they can never block the current one.
  if (affectedSessionIds.size) {
    const { maybeCompleteSession } = require('../utils/sessionStatus');
    for (const sid of affectedSessionIds) {
      if (!sid) continue;
      try { await maybeCompleteSession(sid); }
      catch (e) { console.warn(`[archiveProduct] maybeCompleteSession ${sid} failed:`, e?.message || e); }
    }
  }

  // ── Post-transaction: socket emissions + Telegram notifications ──────────
  for (const { buyerTelegramId } of orderNotifications) {
    try {
      const io = getIO();
      if (io) {
        io.emit('user_order_updated', { buyerTelegramId });
        // Target the affected buyer directly so the OOS notification does not
        // depend on the catalog/order-count hook being mounted on the current tab.
        io.to(`user_${buyerTelegramId}`).emit('user_product_archived', {
          productId: String(product._id),
          reason,
        });
      }
    } catch (e) {
      console.warn('[archiveProduct] socket user_order_updated failed:', e.message);
    }

    if (notifyBuyers && bot) {
      await bot
        .sendMessage(
          buyerTelegramId,
          `⛔ Товар "${getProductTitle(product)}" на складі закінчився. Цю позицію видалено з вашого замовлення.`
        )
        .catch((e) => {
          console.warn(`[archiveProduct] notify buyer ${buyerTelegramId} failed:`, e.message);
          return null;
        });
    }
  }

  // Notify picking dashboards for groups touched by this archive reconciliation.
  if (affectedGroupIds.size > 0) {
    try {
      const io = getIO();
      for (const groupId of affectedGroupIds) {
        io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId });
      }
      io.emit('delivery_groups_updated');
    } catch (e) {
      console.warn('[archiveProduct] socket shop_status_changed failed:', e.message);
    }
  }

  // Notify all clients that the product catalogue changed
  try {
    const io = getIO();
    io.emit('product_archived', { productId: String(product._id) });
    io.emit('incoming_updated');
  } catch (e) {
    console.warn('[archiveProduct] socket product_archived failed:', e.message);
  }

  // ── 5. Broadcast block updates (blocks were already updated inside the transaction) ───
  if (affectedBlockIds.length) {
    try {
      const io = getIO();
      const updatedBlocks = await Block.find({ blockId: { $in: affectedBlockIds } }).lean();
      for (const updated of updatedBlocks) {
        io.emit('block_updated', {
          blockId: updated.blockId,
          version: updated.version,
          productIds: (updated.productIds || []).map(String),
        });
      }
    } catch (e) {
      console.warn('[archiveProduct] socket block_updated failed:', e.message);
    }
  }

  return { cancelledCount };
}

module.exports = { archiveProduct, getProductTitle };
