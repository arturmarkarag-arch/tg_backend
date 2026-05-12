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
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const { shiftDown } = require('../utils/shiftOrderNumbers');
const { getIO } = require('../socket');

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

async function archiveProduct(product, { notifyBuyers = false, bot = null } = {}) {
  const orderNotifications = []; // collected inside tx, emitted after commit
  let cancelledCount = 0;
  let oldOrderNumber;
  let affectedBlockIds = [];

  const session = await mongoose.connection.startSession();
  session.startTransaction();
  try {
    // ── 1. Reconcile active orders ───────────────────────────────────────────
    const activeOrders = await Order.find({ 'items.productId': product._id }).session(session);

    for (const order of activeOrders) {
      const matchingItems = order.items.filter(
        (i) => String(i.productId) === String(product._id) && !i.packed && !i.cancelled
      );
      if (!matchingItems.length) continue;

      for (const item of matchingItems) {
        order.totalPrice = Math.max(0, order.totalPrice - item.price * item.quantity);
        item.cancelled = true;
        cancelledCount += 1;
      }

      const isFullyProcessed = order.items.every((i) => i.packed || i.cancelled);
      if (isFullyProcessed) {
        const allCancelled = order.items.every((i) => i.cancelled);
        order.status = allCancelled ? 'cancelled' : 'confirmed';
      } else {
        order.status = 'in_progress';
      }

      await order.save({ session });
      orderNotifications.push({ orderId: String(order._id), buyerTelegramId: order.buyerTelegramId });
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
    affectedBlockIds = affectedBlocks.map((b) => b.blockId);
    if (affectedBlockIds.length) {
      await Block.updateMany(
        { productIds: product._id },
        { $pull: { productIds: product._id }, $inc: { version: 1 } },
        { session }
      );
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  // ── Post-transaction: socket emissions + Telegram notifications ──────────
  for (const { orderId, buyerTelegramId } of orderNotifications) {
    try {
      const io = getIO();
      io.emit('order_updated', { orderId, buyerTelegramId });
    } catch (e) {
      console.warn('[archiveProduct] socket order_updated failed:', e.message);
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

  // Notify all clients that the product catalogue changed
  try {
    const io = getIO();
    io.emit('product_archived', { productId: String(product._id) });
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
