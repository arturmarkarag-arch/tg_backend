/**
 * Unified Product archive application command.
 *
 * DB state mutation lives in archiveProductPrimitives so wider workflows (for
 * example Receipt routing correction) can compose the SAME archive semantics in
 * their own transaction. This command owns retry + post-commit side effects.
 */
const mongoose = require('mongoose');
const Block = require('../models/Block');
const { getIO } = require('../socket');
const { refreshPickingTaskPositions } = require('./taskBuilder');
const { archiveProductInSession, getProductTitle } = require('./archiveProductPrimitives');

const ARCHIVE_MAX_RETRIES = 3;

function isTransientTxError(err) {
  const labels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  return (
    err?.code === 112
    || err?.codeName === 'WriteConflict'
    || labels.includes('TransientTransactionError')
    || err?.hasErrorLabel?.('TransientTransactionError')
  );
}

/**
 * Executes post-commit effects for a committed archive primitive result.
 * Exported so a wider transaction can preserve one mutation implementation and
 * still publish the same sockets/session repair after ITS commit.
 */
async function publishArchiveProductOutcome(
  outcome,
  { notifyBuyers = false, bot = null, reason = 'manual_archive' } = {},
) {
  if (!outcome?.product || !outcome.changed) return { cancelledCount: outcome?.cancelledCount || 0 };
  const product = outcome.product;

  // Re-evaluate each affected session independently. Historical sessions may heal
  // but never block the current cycle.
  if (outcome.affectedSessionIds?.length) {
    const { maybeCompleteSession } = require('../utils/sessionStatus');
    for (const sessionId of outcome.affectedSessionIds) {
      if (!sessionId) continue;
      try { await maybeCompleteSession(sessionId); } catch (_) {}
    }
  }

  for (const { buyerTelegramId } of outcome.orderNotifications || []) {
    try {
      const io = getIO();
      if (io) {
        io.emit('user_order_updated', { buyerTelegramId });
        io.to(`user_${buyerTelegramId}`).emit('user_product_archived', {
          productId: String(product._id),
          reason,
        });
      }
    } catch (_) {}

    if (notifyBuyers && bot) {
      await bot.sendMessage(
        buyerTelegramId,
        `⛔ Товар "${getProductTitle(product)}" на складі закінчився. Цю позицію видалено з вашого замовлення.`,
      ).catch(() => null);
    }
  }

  if (outcome.affectedGroupIds?.length) {
    try {
      const io = getIO();
      for (const groupId of outcome.affectedGroupIds) {
        io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId });
      }
      io.emit('delivery_groups_updated');
    } catch (_) {}
  }

  try {
    const io = getIO();
    io?.emit('product_archived', { productId: String(product._id) });
    io?.emit('incoming_updated');
  } catch (_) {}

  let positionChanges = [];
  if (outcome.affectedBlockIds?.length) {
    try { positionChanges = await refreshPickingTaskPositions(); } catch (_) { positionChanges = []; }
  }

  if (outcome.affectedBlockIds?.length) {
    try {
      const io = getIO();
      const updatedBlocks = await Block.find({ blockId: { $in: outcome.affectedBlockIds } }).lean();
      for (const updated of updatedBlocks) {
        io?.emit('block_updated', {
          blockId: updated.blockId,
          version: updated.version,
          productIds: (updated.productIds || []).map(String),
        });
      }
    } catch (_) {}
  }

  if (positionChanges.length) {
    try { getIO()?.emit('picking_tasks_positions_updated', positionChanges); } catch (_) {}
  }

  return { cancelledCount: outcome.cancelledCount || 0 };
}

async function archiveProduct(
  productOrId,
  { notifyBuyers = false, bot = null, reason = 'manual_archive', actor = null } = {},
) {
  let committed = null;

  for (let attempt = 0; ; attempt += 1) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        committed = await archiveProductInSession(productOrId, {
          session,
          reason,
          actor,
          now: new Date(),
        });
      });
      break;
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= ARCHIVE_MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    } finally {
      await session.endSession();
    }
  }

  // Preserve previous idempotent semantics: already-archived/missing Product
  // performs no duplicate socket/Telegram work.
  if (!committed?.changed) return { cancelledCount: committed?.cancelledCount || 0 };
  return publishArchiveProductOutcome(committed, { notifyBuyers, bot, reason });
}

module.exports = {
  archiveProduct,
  publishArchiveProductOutcome,
  getProductTitle,
};
