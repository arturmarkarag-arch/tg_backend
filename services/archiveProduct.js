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

const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const { shiftDown } = require('../utils/shiftOrderNumbers');
const { getIO } = require('../socket');

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

async function archiveProduct(product, { notifyBuyers = false, bot = null } = {}) {
  // ── 1. Reconcile active orders ─────────────────────────────────────────────
  const activeOrders = await Order.find({
    'items.productId': product._id,
  });

  let cancelledCount = 0;

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

    await order.save();

    try {
      const io = getIO();
      io.emit('order_updated', {
        orderId: String(order._id),
        buyerTelegramId: order.buyerTelegramId,
      });
    } catch (_) {}

    if (notifyBuyers && bot) {
      await bot
        .sendMessage(
          order.buyerTelegramId,
          `⛔ Товар "${getProductTitle(product)}" на складі закінчився. Цю позицію видалено з вашого замовлення.`
        )
        .catch(() => null);
    }
  }

  // ── 2. Close open PickingTasks ─────────────────────────────────────────────
  await PickingTask.updateMany(
    { productId: product._id, status: { $in: ['pending', 'locked'] } },
    { $set: { status: 'completed', lockedBy: null, lockedAt: null } }
  );

  // ── 3. Archive the product ─────────────────────────────────────────────────
  const oldOrderNumber = product.orderNumber;

  product.status = 'archived';
  product.archivedAt = new Date();
  product.originalOrderNumber = oldOrderNumber;
  product.orderNumber = 0;
  await product.save();

  // Notify all clients that the product catalogue changed
  try {
    const io = getIO();
    io.emit('product_archived', { productId: String(product._id) });
  } catch (_) {}

  // ── 4. Shift remaining products down ──────────────────────────────────────
  await shiftDown({ status: { $ne: 'archived' }, orderNumber: { $gt: oldOrderNumber } });

  // ── 5. Remove from blocks + broadcast ─────────────────────────────────────
  const affectedBlocks = await Block.find({ productIds: product._id }).lean();
  const affectedBlockIds = affectedBlocks.map((b) => b.blockId);

  if (affectedBlockIds.length) {
    await Block.updateMany(
      { productIds: product._id },
      { $pull: { productIds: product._id }, $inc: { version: 1 } }
    );

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
    } catch (_) {}
  }

  return { cancelledCount };
}

module.exports = { archiveProduct, getProductTitle };
