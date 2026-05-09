const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { archiveProduct, getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../telegramBot');
const { isOrderingOpen, getWarsawNow, DAY_FULL_UK } = require('../utils/orderingSchedule');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mark Order items as packed and auto-fulfil the Order if all items are done.
 * Call after a PickingTask is completed or out-of-stocked.
 */
async function markOrderItemsPacked(taskItems, productId) {
  // Only mark packed for items that were actually packed by the worker.
  // Items with packed=false are left untouched so archiveProduct can cancel them.
  const orderIds = [...new Set(taskItems.filter((i) => i.packed).map((i) => String(i.orderId)))];
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
async function findAndLockNext(userTelegramId, fromBlock, deliveryGroupId = null) {
  const lock = { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } };
  const opts = { sort: { blockId: 1, positionIndex: 1 }, new: true };

  const fresh = { status: 'pending', skippedBy: { $nin: [userTelegramId] } };
  if (deliveryGroupId) fresh.deliveryGroupId = String(deliveryGroupId);

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
// GET /api/picking/preview?deliveryGroupId=X
// Returns a live list of products ordered for the group, without creating tasks.
// Used when the ordering window is still open — gives warehouse workers a heads-up.
// ---------------------------------------------------------------------------
router.get('/preview', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  const deliveryGroupId = req.query.deliveryGroupId || null;
  const blockIdParam = req.query.blockId ? parseInt(req.query.blockId, 10) : null;

  // If blockId provided, resolve which productIds are in that block
  let blockProductIds = null;
  if (Number.isInteger(blockIdParam) && blockIdParam >= 1) {
    const block = await Block.findOne({ blockId: blockIdParam }, 'productIds').lean();
    blockProductIds = block ? block.productIds.map(String) : [];
  }

  const orderFilter = { status: { $in: ['new', 'in_progress'] } };
  if (deliveryGroupId) {
    orderFilter['buyerSnapshot.deliveryGroupId'] = String(deliveryGroupId);
  }

  const orders = await Order.find(orderFilter)
    .populate('items.productId', 'name description imageUrls localImageUrl status')
    .lean();

  // Aggregate by product: total quantity + list of shops
  const productMap = new Map();
  for (const order of orders) {
    const shopName = order.buyerSnapshot?.shopName || '—';
    for (const item of order.items) {
      if (item.packed || item.cancelled || !item.productId) continue;
      if (item.productId.status === 'archived') continue;
      const pid = String(item.productId._id);
      // Filter by block if specified
      if (blockProductIds !== null && !blockProductIds.includes(pid)) continue;
      const entry = productMap.get(pid) || { product: item.productId, totalQty: 0, shops: [] };
      entry.totalQty += item.quantity || 0;
      const existing = entry.shops.find((s) => s.shopName === shopName);
      if (existing) existing.qty += item.quantity || 0;
      else entry.shops.push({ shopName, qty: item.quantity || 0 });
      productMap.set(pid, entry);
    }
  }

  const items = Array.from(productMap.values()).map(({ product, totalQty, shops }) => {
    const imageUrl =
      (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
      product.localImageUrl ||
      null;
    return {
      productId: String(product._id),
      productTitle: product.name || product.description || 'Без назви',
      imageUrl,
      totalQty,
      shops,
    };
  });

  res.json({ items });
});

// ---------------------------------------------------------------------------
// POST /api/picking/start-session
// Body: { deliveryGroupId?: string }
// Checks ordering window, then atomically builds picking tasks for the group.
// Idempotent: if tasks already exist for this group, returns count without rebuilding.
// ---------------------------------------------------------------------------
router.post('/start-session', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
    const { deliveryGroupId = null } = req.body;

    // 1. Check ordering window and delivery day.
    if (deliveryGroupId) {
      const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean();
      if (group) {
        // getOrderingSchedule() throws if the key is absent from DB — error propagates to catch below.
        const schedule = await getOrderingSchedule();
        const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
        if (isOpen) {
          return res.json({ windowOpen: true, message });
        }
        // Picking is only allowed on the actual delivery day.
        const { dayOfWeek: nowDOW } = getWarsawNow();
        if (nowDOW !== group.dayOfWeek) {
          return res.json({
            wrongDay: true,
            deliveryDayOfWeek: group.dayOfWeek,
            deliveryDayName: DAY_FULL_UK[group.dayOfWeek],
          });
        }
      }
    }

    // 2. Idempotent: if tasks already exist, return their count.
    const activeFilter = {
      status: { $in: ['pending', 'locked'] },
      ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
    };
    const existingCount = await PickingTask.countDocuments(activeFilter);
    if (existingCount > 0) {
      return res.json({ alreadyStarted: true, taskCount: existingCount });
    }

    // 3. Build picking tasks from this group's closed-window orders.
    await buildPickingTasksFromOrders(deliveryGroupId);

    // 4. Return current count. The unique partial index on PickingTask(productId, deliveryGroupId)
    // causes insertMany(ordered:false) to silently skip duplicates, so concurrent calls from
    // multiple server instances never create phantom tasks — no in-process flag needed.
    const taskCount = await PickingTask.countDocuments(activeFilter);

    if (taskCount === 0) {
      return res.json({ noOrders: true });
    }

    res.json({ started: true, taskCount });
  } catch (err) {
    console.error('[picking/start-session]', err);
    res.status(500).json({ error: err.message || 'Помилка запуску сесії збирання' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/next-task?currentBlock=N
// ---------------------------------------------------------------------------
router.get('/next-task', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
    const user = req.telegramUser;
    const currentBlock = parseInt(req.query.currentBlock, 10);
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!Number.isInteger(currentBlock) || currentBlock < 1) {
      return res.status(400).json({ error: 'currentBlock must be a positive integer' });
    }

    // Release any tasks this worker had locked for this group (stale locks from previous session).
    await PickingTask.updateMany(
      { lockedBy: user.telegramId, status: 'locked', ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}) },
      { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
    );

    const { task, wrappedAround } = await findAndLockNext(user.telegramId, currentBlock, deliveryGroupId);
    if (!task) {
      const pendingFilter = { status: 'pending' };
      if (deliveryGroupId) pendingFilter.deliveryGroupId = String(deliveryGroupId);
      const pendingCount = await PickingTask.countDocuments(pendingFilter);
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
      const pendingFilter = { status: 'pending' };
      if (deliveryGroupId) pendingFilter.deliveryGroupId = String(deliveryGroupId);
      const pendingCount = await PickingTask.countDocuments(pendingFilter);
      return res.json({ task: null, reviewMode: pendingCount > 0, message: 'Немає задач для збирання' });
    }

    res.json({ task: taskData });
  } catch (err) {
    console.error('[picking/next-task]', err);
    res.status(500).json({ error: err.message || 'Помилка отримання задачі' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/complete
// Body: { items: [{ orderId, actualQty }], nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/complete', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
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
    const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock, task.deliveryGroupId || null);
    const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

    res.json({ message: 'Task completed', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/complete]', err);
    res.status(500).json({ error: err.message || 'Помилка завершення задачі' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/skip
// Body: { nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/skip', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
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
    const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock, task.deliveryGroupId || null);
    const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

    res.json({ message: 'Task skipped', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/skip]', err);
    res.status(500).json({ error: err.message || 'Помилка пропуску задачі' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/review-list  — all pending tasks (no locking), for the review screen
// ---------------------------------------------------------------------------
router.get('/review-list', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
    const deliveryGroupId = req.query.deliveryGroupId || null;
    const filter = { status: 'pending' };
    if (deliveryGroupId) filter.deliveryGroupId = String(deliveryGroupId);
    const tasks = await PickingTask.find(filter)
      .sort({ blockId: 1, positionIndex: 1 })
      .lean();

    const results = await Promise.all(tasks.map((t) => buildTaskResponse(t)));
    res.json({ tasks: results.filter(Boolean) });
  } catch (err) {
    console.error('[picking/review-list]', err);
    res.status(500).json({ error: err.message || 'Помилка завантаження списку' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/picking/tasks/:taskId/progress
// Body: { packedOrderIds: string[] }
// Saves partial packed state without completing the task.
// ---------------------------------------------------------------------------
router.patch('/tasks/:taskId/progress', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
    const user = req.telegramUser;
    const { packedOrderIds = [] } = req.body;

    const task = await PickingTask.findById(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.lockedBy !== user.telegramId) {
      return res.status(403).json({ error: 'Task is not locked by you' });
    }

    const packedSet = new Set(packedOrderIds.map(String));
    for (const item of task.items) {
      item.packed = packedSet.has(String(item.orderId));
    }
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('[picking/progress]', err);
    res.status(500).json({ error: err.message || 'Помилка збереження прогресу' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/claim  — atomically lock a task from the review list
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
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
  } catch (err) {
    console.error('[picking/claim]', err);
    res.status(500).json({ error: err.message || 'Помилка призначення задачі' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/out-of-stock
// Body: { nextBlock?: N, packedOrderIds?: string[] }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/out-of-stock', requireTelegramRoles(['warehouse', 'admin']), async (req, res) => {
  try {
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
      item.packed = wasPacked;
      if (wasPacked) packedShops.push(item.shopName || String(item.orderId));
      else missedShops.push(item.shopName || String(item.orderId));
    }

    task.status = 'completed';
    task.lockedBy = null;
    task.lockedAt = null;
    await task.save();

    // Mark Order items as packed and auto-fulfil fully-packed orders
    await markOrderItemsPacked(task.items, task.productId);

    // Archive the product — removes it from blocks and cancels remaining orders.
    const productDoc = await Product.findById(task.productId._id || task.productId);
    if (productDoc && productDoc.status !== 'archived') {
      await archiveProduct(productDoc, { notifyBuyers: false, bot: null });
    }

    const fromBlock = typeof nextBlock === 'number' ? nextBlock : blockId;
    const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock, task.deliveryGroupId || null);
    const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

    res.json({ message: 'Out-of-stock recorded', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/out-of-stock]', err);
    res.status(500).json({ error: err.message || 'Помилка запису "немає на складі"' });
  }
});

module.exports = router;
