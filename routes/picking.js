const express = require('express');
const mongoose = require('mongoose');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { archiveProduct, getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { isOrderingOpen, getWarsawNow, DAY_FULL_UK, getCurrentOrderingSessionId, getOrderingWindowCloseAt } = require('../utils/orderingSchedule');

const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError } = require('../utils/errors');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mark Order items as packed and auto-fulfil the Order if all items are done.
 * Call after a PickingTask is completed or out-of-stocked.
 */
async function markOrderItemsPacked(taskItems, productId, actor = { by: 'system', byName: '', byRole: 'system' }, session = null) {
  // Only mark packed for items that were actually packed by the worker.
  // Items with packed=false are left untouched so archiveProduct can cancel them.
  const orderIds = [...new Set(taskItems.filter((i) => i.packed).map((i) => String(i.orderId)))];
  await Promise.all(
    orderIds.map(async (orderId) => {
      const opts = session ? { session } : {};
      // Step 1: mark this product's item as packed
      const result = await Order.updateOne(
        { _id: orderId, 'items.productId': productId },
        { $set: { 'items.$.packed': true } },
        opts,
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
        {
          $set: { status: 'fulfilled' },
          $push: { history: { at: new Date(), ...actor, action: 'status_changed', meta: { from: 'in_progress', to: 'fulfilled', via: 'picking' } } },
        },
        opts,
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

  const fresh = { status: 'pending' };
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
// POST /api/picking/start-session
// Body: { deliveryGroupId?: string }
// Checks ordering window, then atomically builds picking tasks for the group.
// Idempotent: if tasks already exist for this group, returns count without rebuilding.
// ---------------------------------------------------------------------------
router.post('/start-session', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const { deliveryGroupId = null } = req.body;
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
    }

    // 1. Check ordering window and delivery day.
    const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean();
    if (group) {
      // getOrderingSchedule() throws if the key is absent from DB — error propagates to catch below.
      const schedule = await getOrderingSchedule();
      const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
      if (isOpen) {
        const windowCloseAt = getOrderingWindowCloseAt(group.dayOfWeek, schedule).toISOString();
        return res.json({ windowOpen: true, message, windowCloseAt });
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

    // 2. Idempotent: if tasks already exist, return their count.
    const activeFilter = {
      status: { $in: ['pending', 'locked'] },
      deliveryGroupId: String(deliveryGroupId),
    };
    const existingCount = await PickingTask.countDocuments(activeFilter);
    if (existingCount > 0) {
      return res.json({ alreadyStarted: true, taskCount: existingCount });
    }

    // 3. Detect stale orders from previous sessions.
    // These orders should NOT block warehouse flow; admins resolve them separately.
    const group2 = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek').lean();
    if (group2) {
      const schedule2 = await getOrderingSchedule();
      const currentSessionId = getCurrentOrderingSessionId(String(deliveryGroupId), group2.dayOfWeek, schedule2);
      const staleOrders = await Order.find(
        {
          'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
          status: { $in: ['new', 'in_progress'] },
          orderingSessionId: { $ne: currentSessionId },
        },
        'buyerSnapshot buyerTelegramId orderingSessionId',
      ).lean();

      // 4. Build picking tasks only from the CURRENT session.
      await buildPickingTasksFromOrders(deliveryGroupId, { orderingSessionId: currentSessionId });

      // 5. Return stale warnings for admin visibility without blocking start.
      const staleWarnings = staleOrders.map((o) => ({
        orderId: String(o._id),
        shopName: o.buyerSnapshot?.shopName || '—',
        shopCity: o.buyerSnapshot?.shopCity || '',
        buyerTelegramId: String(o.buyerTelegramId),
      }));

      const taskCount = await PickingTask.countDocuments(activeFilter);
      if (taskCount === 0) {
        return res.json({ noOrders: true, staleWarnings });
      }
      return res.json({ started: true, taskCount, staleWarnings });
    }

    // Fallback: if group lookup failed, keep previous behavior without session scoping.
    await buildPickingTasksFromOrders(deliveryGroupId);

    // Return current count. The unique partial index on PickingTask(productId, deliveryGroupId)
    // causes insertMany(ordered:false) to silently skip duplicates, so concurrent calls from
    // multiple server instances never create phantom tasks — no in-process flag needed.
    const taskCount = await PickingTask.countDocuments(activeFilter);

    if (taskCount === 0) {
      return res.json({ noOrders: true });
    }

    res.json({ started: true, taskCount });
  } catch (err) {
    console.error('[picking/start-session]', err);
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/next-task?currentBlock=N
// ---------------------------------------------------------------------------
router.get('/next-task', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const currentBlock = parseInt(req.query.currentBlock, 10);
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!Number.isInteger(currentBlock) || currentBlock < 1) {
      return next(appError('picking_current_block_invalid'));
    }

    // Release stale locks:
    //  - always release this worker's own locks (from a previous request / page reload)
    //  - release any worker's lock that is older than LOCK_TIMEOUT_MS (abandoned tasks)
    // Does NOT touch items[].packed so partial progress is preserved for the next worker.
    const LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
    const staleLockedAt = new Date(Date.now() - LOCK_TIMEOUT_MS);
    await PickingTask.updateMany(
      {
        status: 'locked',
        ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
        $or: [
          { lockedBy: user.telegramId },
          { lockedAt: { $lt: staleLockedAt } },
        ],
      },
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
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/complete
// Body: { items: [{ orderId, actualQty }], nextBlock?: N }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/complete', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { items = [], nextBlock } = req.body;

    const task = await PickingTask.findById(req.params.taskId);
    if (!task) return next(appError('picking_task_not_found'));
    if (task.lockedBy !== user.telegramId) return next(appError('expired_lock'));

    // Apply actual packed quantities
    for (const item of task.items) {
      const input = items.find((i) => String(i.orderId) === String(item.orderId));
      if (input !== undefined) {
        item.packedQuantity = Math.max(0, Number(input.actualQty) || 0);
      } else {
        item.packedQuantity = item.quantity; // default: assume fully packed
      }
      item.packed = item.packedQuantity > 0;
    }

    task.status = 'completed';
    task.lockedBy = null;
    task.lockedAt = null;

    // Atomically save task + mark order items in one transaction so they
    // can't diverge if the server crashes between the two writes.
    const completeActor = { by: String(user.telegramId), byName: [user.firstName, user.lastName].filter(Boolean).join(' '), byRole: user.role };
    const completeSess = await mongoose.connection.startSession();
    try {
      await completeSess.withTransaction(async () => {
        await task.save({ session: completeSess });
        await markOrderItemsPacked(task.items, task.productId, completeActor, completeSess);
      });
    } finally {
      await completeSess.endSession();
    }

    const fromBlock = typeof nextBlock === 'number' ? nextBlock : task.blockId;
    const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlock, task.deliveryGroupId || null);
    const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });

    res.json({ message: 'Task completed', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/complete]', err);
    next(appError('picking_complete_failed'));
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/picking/tasks/:taskId/progress
// Body: { packedOrderIds: string[] }
// Saves partial packed state without completing the task.
// ---------------------------------------------------------------------------
router.patch('/tasks/:taskId/progress', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { packedOrderIds = [] } = req.body;

    const task = await PickingTask.findById(req.params.taskId);
    if (!task) return next(appError('picking_task_not_found'));
    if (task.lockedBy !== user.telegramId) return next(appError('expired_lock'));

    const packedSet = new Set(packedOrderIds.map(String));
    for (const item of task.items) {
      item.packed = packedSet.has(String(item.orderId));
    }
    await task.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('[picking/progress]', err);
    next(appError('picking_progress_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/claim  — atomically lock a task from the review list
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;

    const claimed = await PickingTask.findOneAndUpdate(
      { _id: req.params.taskId, status: 'pending' },
      { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
      { new: true },
    );
    if (!claimed) return next(appError('picking_claim_unavailable'));

    const taskData = await buildTaskResponse(claimed);
    if (!taskData) {
      await PickingTask.findByIdAndUpdate(claimed._id, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
      return next(appError('picking_product_not_found'));
    }
    res.json({ task: taskData });
  } catch (err) {
    console.error('[picking/claim]', err);
    next(appError('picking_claim_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/out-of-stock
// Body: { nextBlock?: N, packedOrderIds?: string[] }
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/out-of-stock', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { nextBlock, packedOrderIds = [] } = req.body;

    let task = await PickingTask.findById(req.params.taskId);
    if (!task) return next(appError('picking_task_not_found'));

    // Idempotency: if a previous request saved the task but archiveProduct crashed,
    // retry the archive now and return success.
    if (task.status === 'completed') {
      const productForRetry = await Product.findById(task.productId);
      if (productForRetry && productForRetry.status !== 'archived') {
        await archiveProduct(productForRetry, { notifyBuyers: false, bot: null });
      }
      const fromBlockRetry = typeof nextBlock === 'number' ? nextBlock : task.blockId;
      const { task: nextTask, wrappedAround: nwa } = await findAndLockNext(user.telegramId, fromBlockRetry, task.deliveryGroupId || null);
      const nextTaskData = await buildTaskResponse(nextTask, { wrappedAround: nwa });
      return res.json({ message: 'Out-of-stock recorded', nextTask: nextTaskData });
    }

    // Auto-claim if called from review list (task still pending)
    if (task.status === 'pending') {
      const claimed = await PickingTask.findOneAndUpdate(
        { _id: task._id, status: 'pending' },
        { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
        { new: true },
      );
      if (!claimed) return next(appError('picking_claim_taken_by_other'));
      task = claimed;
    } else if (task.lockedBy !== user.telegramId) {
      return next(appError('expired_lock'));
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

    // Phase 1: atomically save task + mark order items so they can't diverge
    // on a mid-request server crash.
    const outOfStockActor = { by: String(user.telegramId), byName: [user.firstName, user.lastName].filter(Boolean).join(' '), byRole: user.role };
    const oosSess = await mongoose.connection.startSession();
    try {
      await oosSess.withTransaction(async () => {
        await task.save({ session: oosSess });
        await markOrderItemsPacked(task.items, task.productId, outOfStockActor, oosSess);
      });
    } finally {
      await oosSess.endSession();
    }

    // Phase 2: archive product (runs its own internal transaction).
    // NOT wrapped in try-catch — if this fails, the client receives 500 and
    // can retry; the idempotency block above will re-attempt the archive.
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
    next(appError('picking_oos_failed'));
  }
});

module.exports = router;
