const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { archiveProduct, getProductTitle } = require('../services/archiveProduct');
const { sendMessageWithRetry, buildPickingTasksFromOrders } = require('../telegramBot');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mark Order items as packed and auto-fulfil the Order if all items are done.
 * Call after a PickingTask is completed or out-of-stocked.
 */
async function markOrderItemsPacked(taskItems, productId) {
  const orderIds = [...new Set(taskItems.map((i) => String(i.orderId)))];
  await Promise.all(
    orderIds.map(async (orderId) => {
      // Step 1: mark this product's item as packed
      const result = await Order.updateOne(
        { _id: orderId, 'items.productId': productId },
        { $set: { 'items.$.packed': true } },
      );
      if (result.matchedCount === 0) return;

      // Step 2: atomically fulfil if every non-cancelled item is now packed.
      // The filter condition is evaluated by MongoDB in one operation — no race.
      await Order.updateOne(
        {
          _id: orderId,
          status: { $in: ['new', 'in_progress'] },
          'items': { $not: { $elemMatch: { packed: false, cancelled: false } } },
        },
        { $set: { status: 'fulfilled' } },
      );
    })
  );
}

async function buildTaskResponse(task, { wrappedAround = false, isSecondChance = false } = {}) {
  if (!task) return null;
  const product = await Product.findById(task.productId).lean();
  if (!product) return null;

  const imageUrl =
    (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
    product.localImageUrl ||
    null;

  return {
    taskId: String(task._id),
    productId: String(product._id),
    productTitle: getProductTitle(product),
    imageUrl,
    blockId: task.blockId,
    positionIndex: task.positionIndex,
    status: task.status,
    lockedBy: task.lockedBy,
    wrappedAround,
    isSecondChance,
    items: (task.items || []).map((item) => ({
      orderId: String(item.orderId),
      shopName: item.shopName || '',
      quantity: item.quantity,
      packedQuantity: item.packedQuantity ?? null,
      packed: item.packed,
    })),
  };
}

/**
 * Atomically lock the next pending task for a given worker.
 *
 * Normal flow (ignores tasks this worker already skipped):
 *   Pass 1: fromBlock → end of warehouse
 *   Pass 2: wrap-around 1 → fromBlock-1
 */
/**
 * @returns {{ task: object|null, wrappedAround: boolean }}
 */
async function findAndLockNext(userTelegramId, fromBlock) {
  const lock = { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } };
  const opts = { sort: { blockId: 1, positionIndex: 1 }, new: true };

  const fresh = { status: 'pending', skippedBy: { $nin: [userTelegramId] } };

  // Pass 1: fresh tasks fromBlock onwards
  let task = await PickingTask.findOneAndUpdate(
    { ...fresh, blockId: { $gte: fromBlock } }, lock, opts,
  );
  if (task) return { task, wrappedAround: false };

  // Pass 2: fresh tasks wrap-around
  if (fromBlock > 1) {
    task = await PickingTask.findOneAndUpdate(
      { ...fresh, blockId: { $gte: 1, $lt: fromBlock } }, lock, opts,
    );
    if (task) return { task, wrappedAround: true };
  }

  return { task: null, wrappedAround: false };
}

// ---------------------------------------------------------------------------
// GET /api/picking/next-task?currentBlock=N
// ---------------------------------------------------------------------------
router.get('/next-task', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const user = req.telegramUser;
  const currentBlock = parseInt(req.query.currentBlock, 10);

  if (!Number.isInteger(currentBlock) || currentBlock < 1) {
    return res.status(400).json({ error: 'currentBlock must be a positive integer' });
  }

  // Auto-generate tasks from active orders (idempotent, skips duplicates)
  await buildPickingTasksFromOrders();
  await PickingTask.updateMany(
    { lockedBy: user.telegramId, status: 'locked' },
    { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
  );

  const { task, wrappedAround } = await findAndLockNext(user.telegramId, currentBlock);
  if (!task) {
    const pendingCount = await PickingTask.countDocuments({ status: 'pending' });
    return res.json({
      task: null,
      reviewMode: pendingCount > 0,
      message: pendingCount > 0 ? 'Залишились пропущені задачі' : 'Немає задач для збирання',
    });
  }

  const taskData = await buildTaskResponse(task, { wrappedAround });
  if (!taskData) {
    // Product archived — release and return empty
    await PickingTask.findByIdAndUpdate(task._id, {
      $set: { status: 'pending', lockedBy: null, lockedAt: null },
    });
    const pendingCount = await PickingTask.countDocuments({ status: 'pending' });
    return res.json({ task: null, reviewMode: pendingCount > 0, message: 'Немає задач для збирання' });
  }

  res.json({ task: taskData });
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/complete
// Body: { items: [{ orderId, actualQty }], nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/complete', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const user = req.telegramUser;
  const { items = [], nextBlock } = req.body;

  const task = await PickingTask.findById(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.lockedBy !== user.telegramId) {
    return res.status(403).json({ error: 'Task is not locked by you' });
  }

  // Apply actual packed quantities
  for (const item of task.items) {
    const input = items.find((i) => String(i.orderId) === String(item.orderId));
    if (input !== undefined) {
      item.packedQuantity = Math.max(0, Number(input.actualQty) || 0);
    } else {
      item.packedQuantity = item.quantity; // default: assume fully packed
    }
    item.packed = true;
  }

  task.status = 'completed';
  task.lockedBy = null;
  task.lockedAt = null;
  await task.save();

  // Mark Order items as packed and auto-fulfil fully-packed orders
  await markOrderItemsPacked(task.items, task.productId);

  const fromBlock = typeof nextBlock === 'number' ? nextBlock : task.blockId;
  const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock);
  const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

  res.json({ message: 'Task completed', nextTask: nextTaskData });
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/skip
// Body: { nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/skip', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const user = req.telegramUser;
  const { nextBlock } = req.body;

  const task = await PickingTask.findById(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.lockedBy !== user.telegramId) {
    return res.status(403).json({ error: 'Task is not locked by you' });
  }

  const fromBlock = typeof nextBlock === 'number' ? nextBlock : task.blockId;

  task.status = 'pending';
  task.lockedBy = null;
  task.lockedAt = null;
  if (!task.skippedBy.includes(user.telegramId)) {
    task.skippedBy.push(user.telegramId);
  }
  await task.save();

  // skippedBy now includes this user → findAndLockNext will skip this task
  const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock);
  const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

  res.json({ message: 'Task skipped', nextTask: nextTaskData });
});

// ---------------------------------------------------------------------------
// GET /api/picking/review-list  — all pending tasks (no locking), for the review screen
// ---------------------------------------------------------------------------
router.get('/review-list', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const tasks = await PickingTask.find({ status: 'pending' })
    .sort({ blockId: 1, positionIndex: 1 })
    .lean();

  const results = await Promise.all(tasks.map((t) => buildTaskResponse(t)));
  res.json({ tasks: results.filter(Boolean) });
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/claim  — atomically lock a task from the review list
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const user = req.telegramUser;

  const claimed = await PickingTask.findOneAndUpdate(
    { _id: req.params.taskId, status: 'pending' },
    { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return res.status(409).json({ error: 'Task is no longer available' });

  const taskData = await buildTaskResponse(claimed);
  if (!taskData) {
    await PickingTask.findByIdAndUpdate(claimed._id, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json({ task: taskData });
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/out-of-stock
// Body: { nextBlock?: N, packedOrderIds?: string[] }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/out-of-stock', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const user = req.telegramUser;
  const { nextBlock, packedOrderIds = [] } = req.body;

  let task = await PickingTask.findById(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Auto-claim if called from review list (task still pending)
  if (task.status === 'pending') {
    const claimed = await PickingTask.findOneAndUpdate(
      { _id: task._id, status: 'pending' },
      { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
      { new: true },
    );
    if (!claimed) return res.status(409).json({ error: 'Task was claimed by another worker' });
    task = claimed;
  } else if (task.lockedBy !== user.telegramId) {
    return res.status(403).json({ error: 'Task is not locked by you' });
  }

  await task.populate('productId');

  const productTitle = getProductTitle(task.productId) || 'Невідомий товар';
  const blockId = task.blockId;
  const packedSet = new Set(packedOrderIds.map(String));

  const packedShops = [];
  const missedShops = [];

  for (const item of task.items) {
    const wasPacked = packedSet.has(String(item.orderId));
    item.packedQuantity = wasPacked ? item.quantity : 0;
    item.packed = true;
    if (wasPacked) packedShops.push(item.shopName || String(item.orderId));
    else missedShops.push(item.shopName || String(item.orderId));
  }

  task.status = 'completed';
  task.lockedBy = null;
  task.lockedAt = null;
  await task.save();

  // Mark Order items as packed and auto-fulfil fully-packed orders
  await markOrderItemsPacked(task.items, task.productId);

  // Archive the product — removes it from blocks, cancels remaining orders, notifies buyers
  const productDoc = await Product.findById(task.productId._id || task.productId);
  if (productDoc && productDoc.status !== 'archived') {
    await archiveProduct(productDoc, { notifyBuyers: true, bot: null });
  }

  // Notify managers & admins
  const workerName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.telegramId);

  let alertMsg = `⚠️ Товар закінчився на складі!`;
  if (packedShops.length > 0) {
    alertMsg += `\n\n✅ Отримали (${packedShops.length}):\n` + packedShops.map((s) => `  • ${s}`).join('\n');
  }
  if (missedShops.length > 0) {
    alertMsg += `\n\n❌ Не вистачило (${missedShops.length}):\n` + missedShops.map((s) => `  • ${s}`).join('\n');
  }

  try {
    const recipients = await User.find({
      $or: [{ role: 'admin' }, { role: 'warehouse', isWarehouseManager: true }],
      botBlocked: { $ne: true },
    }).lean();
    await Promise.allSettled(recipients.map((r) => sendMessageWithRetry(r.telegramId, alertMsg)));
  } catch (err) {
    console.warn('[Picking] Failed to notify about out-of-stock:', err?.message || err);
  }

  const fromBlock = typeof nextBlock === 'number' ? nextBlock : blockId;
  const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock);
  const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

  res.json({ message: 'Out-of-stock recorded, managers notified', nextTask: nextTaskData });
});

module.exports = router;
