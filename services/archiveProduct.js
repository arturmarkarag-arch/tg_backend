/**
 * Unified product archive service.
 *
 * Handles full reconciliation for BOTH manual (admin UI) and sold-out (bot /ship) scenarios:
 *  - Cancels unpacked items in active orders and recomputes order status/totalPrice
 *  - Closes pending/locked PickingTasks for this product
 *  - Sets product status → 'archived', preserves originalOrderNumber
 *  - Shifts orderNumbers of remaining products down
 *  - Removes the product from any warehouse blocks and broadcasts block_updated
 *
 * @param {import('../models/Product').default} product  Mongoose document (must be a full doc, not lean)
 * @param {object}  [opts]
 * @param {boolean} [opts.notifyBuyers=false]  Send Telegram message to affected buyers
 * @param {object}  [opts.bot=null]            node-telegram-bot-api instance (required when notifyBuyers=true)
 * @returns {Promise<{ cancelledCount: number }>}
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const { shiftDown } = require('../utils/shiftOrderNumbers');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { getIO } = require('../socket');

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

const ARCHIVE_MAX_RETRIES = 3;

// A WriteConflict (code 112) is transient: two transactions touched the same
// docs (e.g. concurrent archives both running shiftDown over the orderNumber
// space). Retrying with a fresh read resolves it.
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
async function archiveProduct(productOrId, { notifyBuyers = false, bot = null } = {}) {
  const productId = (productOrId && productOrId._id) ? productOrId._id : productOrId;

  // Captured from the committed attempt; emitted AFTER commit (once).
  let product;
  let orderNotifications = [];
  let affectedGroupIds = new Set();
  let cancelledCount = 0;
  let affectedBlockIds = [];

  for (let attempt = 0; ; attempt += 1) {
    // Per-attempt accumulators — reset on every retry.
    const attemptNotifications = [];
    const attemptGroupIds = new Set();
    let attemptCancelled = 0;
    let oldOrderNumber;
    let attemptBlockIds = [];
    const groupOpenCache = new Map();
    let cachedSchedule = null;
    let scheduleLoaded = false;

    const session = await mongoose.connection.startSession();
    session.startTransaction();
    try {
      // Re-read FRESH inside the session each attempt. Idempotent no-op if the
      // product vanished or was already archived by a concurrent path.
      product = await Product.findById(productId).session(session);
      if (!product || product.status === 'archived') {
        await session.abortTransaction();
        return { cancelledCount: 0 }; // finally ends the session
      }

      const isGroupOrderingOpen = async (deliveryGroupId) => {
      const key = String(deliveryGroupId || '');
      if (!key) return false;
      if (groupOpenCache.has(key)) return groupOpenCache.get(key);

      if (!scheduleLoaded) {
        try {
          cachedSchedule = await getOrderingSchedule();
        } catch {
          cachedSchedule = null;
        }
        scheduleLoaded = true;
      }

      // Fail-safe: if schedule is unavailable, freeze status transitions.
      if (!cachedSchedule) {
        groupOpenCache.set(key, true);
        return true;
      }

      const group = await DeliveryGroup.findById(key, 'dayOfWeek').session(session).lean();
      if (!group) {
        groupOpenCache.set(key, true);
        return true;
      }

      const { isOpen } = isOrderingOpen(group.dayOfWeek, cachedSchedule);
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
        (i) => String(i.productId) === String(product._id) && !i.packed && !i.cancelled
      );
      if (!matchingItems.length) continue;

      for (const item of matchingItems) {
        order.totalPrice = Math.max(0, require('../utils/money').roundMoney(order.totalPrice - item.price * item.quantity));
        item.cancelled = true;
        attemptCancelled += 1;
      }

      const orderingOpenNow = await isGroupOrderingOpen(order.buyerSnapshot?.deliveryGroupId);
      if (!orderingOpenNow) {
        const isFullyProcessed = order.items.every((i) => i.packed || i.cancelled);
        if (isFullyProcessed) {
          const allCancelled = order.items.every((i) => i.cancelled);
          order.status = allCancelled ? 'cancelled' : 'confirmed';
        } else {
          order.status = 'in_progress';
        }
      }

      await order.save({ session });
      attemptNotifications.push({ orderId: String(order._id), buyerTelegramId: order.buyerTelegramId });
      if (order.buyerSnapshot?.deliveryGroupId) {
        attemptGroupIds.add(String(order.buyerSnapshot.deliveryGroupId));
      }
    }

    // ── 2. Close open PickingTasks ───────────────────────────────────────────
    await PickingTask.updateMany(
      { productId: product._id, status: { $in: ['pending', 'locked'] } },
      { $set: { status: 'completed', lockedBy: null, lockedAt: null } },
      { session }
    );

    // ── 3. Archive the product ───────────────────────────────────────────────
    oldOrderNumber = product.orderNumber;
    product.status = 'archived';
    product.archivedAt = new Date();
    product.originalOrderNumber = oldOrderNumber;
    product.orderNumber = 0;
    await product.save({ session });

    // ── 4. Shift remaining products down ────────────────────────────────────
    await shiftDown({ status: { $ne: 'archived' }, orderNumber: { $gt: oldOrderNumber } }, session);

    // ── 5. Remove from blocks (inside transaction so it's atomic with archive) ──
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
      affectedBlockIds   = attemptBlockIds;
      break;
    } catch (err) {
      await session.abortTransaction();
      // finally runs on both throw and continue, so endSession happens once there.
      if (!isTransientTxError(err) || attempt >= ARCHIVE_MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      continue;
    } finally {
      session.endSession();
    }
  }

  // ── Post-transaction: socket emissions + Telegram notifications ──────────
  for (const { buyerTelegramId } of orderNotifications) {
    try {
      const io = getIO();
      io.emit('user_order_updated', { buyerTelegramId });
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
