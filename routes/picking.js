const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { isOrderingOpen, getWarsawNow, DAY_FULL_UK, getCurrentOrderingSessionId, getOrderingWindowCloseAt } = require('../utils/orderingSchedule');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');

const {
  findAndLockNext,
  releaseWorkerAndStaleLocks,
  completePickingTask,
  outOfStockPickingTask,
  forceClaimPickingTask,
  reconcileActiveTasksForSession,
  archiveOrphanedOutOfStockProducts,
  FORCE_CLAIM_AFTER_MS,
} = require('../services/pickingService');

const router = express.Router();

// ---------------------------------------------------------------------------
// Local helpers (route-layer only — not business logic)
// ---------------------------------------------------------------------------

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
 * Keep active tasks aligned with one ordering session.
 * Removes task items that belong to orders outside the target session and
 * drops empty active tasks so old sessions cannot block a new picking start.
 */

// ---------------------------------------------------------------------------
// GET /api/picking/schedule
// Returns current ordering schedule used for picking gate UI.
// ---------------------------------------------------------------------------
router.get('/schedule', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const schedule = await getOrderingSchedule();
    res.json({
      openHour: Number(schedule.openHour),
      openMinute: Number(schedule.openMinute),
      closeHour: Number(schedule.closeHour),
      closeMinute: Number(schedule.closeMinute),
    });
  } catch (err) {
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/start-session
// Body: { deliveryGroupId?: string }
// Checks ordering window, then atomically builds picking tasks for the group.
// Idempotent: if tasks already exist for this group, returns count without rebuilding.
// ---------------------------------------------------------------------------
router.post('/start-session', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { deliveryGroupId = null } = req.body;
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
    }

    // 1. Check ordering window and delivery day.
    const group = normalizeDeliveryGroup(await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean());
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
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId);

    const groupForSession = normalizeDeliveryGroup(await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean());
    let currentSessionId = null;
    if (groupForSession) {
      const schedule = await getOrderingSchedule();
      currentSessionId = getCurrentOrderingSessionId(String(deliveryGroupId), groupForSession.dayOfWeek, schedule);
      // Fix any products left un-archived from a previous crashed out-of-stock flow
      await archiveOrphanedOutOfStockProducts(deliveryGroupId);
      await reconcileActiveTasksForSession(deliveryGroupId, currentSessionId);
    }

    const activeFilter = {
      status: { $in: ['pending', 'locked'] },
      deliveryGroupId: String(deliveryGroupId),
    };
    const pendingFilter = {
      status: 'pending',
      deliveryGroupId: String(deliveryGroupId),
    };

    const existingActiveCount = await PickingTask.countDocuments(activeFilter);
    const availableCount = await PickingTask.countDocuments(pendingFilter);
    if (existingActiveCount > 0) {
      return res.json({ alreadyStarted: true, taskCount: availableCount });
    }

    // 3. Detect stale orders from previous sessions.
    // These orders should NOT block warehouse flow; admins resolve them separately.
    const group2 = groupForSession;
    if (group2) {
      if (!currentSessionId) {
        const schedule2 = await getOrderingSchedule();
        currentSessionId = getCurrentOrderingSessionId(String(deliveryGroupId), group2.dayOfWeek, schedule2);
      }
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

      const taskCount = await PickingTask.countDocuments(pendingFilter);
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
    const taskCount = await PickingTask.countDocuments(pendingFilter);

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
    //  - release any worker's lock that is older than timeout (abandoned tasks)
    // Does NOT touch items[].packed so partial progress is preserved for the next worker.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId);

    // Recovery: якщо сервер упав між фазою 1 (task completed) і фазою 2 (archiveProduct)
    // в out-of-stock flow — довиконуємо архівування тут, а не тільки в start-session.
    if (deliveryGroupId) {
      archiveOrphanedOutOfStockProducts(deliveryGroupId).catch((e) =>
        console.warn('[picking/next-task] archiveOrphaned failed:', e?.message),
      );
    }

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
      return res.json({
        task: null,
        reviewMode: pendingCount > 0,
        message: pendingCount > 0 ? 'Залишились пропущені задачі' : 'Немає задач для збирання',
      });
    }

    res.json({ task: taskData });
  } catch (err) {
    console.error('[picking/next-task]', err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/block-tasks?blockId=N&deliveryGroupId=...
// Returns active tasks from one block for picker modal (start from specific product).
// ---------------------------------------------------------------------------
router.get('/block-tasks', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const blockId = parseInt(req.query.blockId, 10);
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!Number.isInteger(blockId) || blockId < 1) {
      return next(appError('picking_block_invalid'));
    }

    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId);

    const filter = {
      blockId,
      status: { $in: ['pending', 'locked'] },
      ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
    };

    const tasks = await PickingTask.find(filter)
      .sort({ positionIndex: 1 })
      .lean();

    const productIds = [...new Set(tasks.map((t) => String(t.productId)))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const previewTasks = [];
    for (const task of tasks) {
      const product = productMap.get(String(task.productId));
      if (!product) continue;
      const imageUrl =
        (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
        product.localImageUrl ||
        null;
      const totalQty = (task.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const lockedBy = task.lockedBy ? String(task.lockedBy) : null;
      const lockedByMe = task.status === 'locked' && lockedBy === String(user.telegramId);
      const lockedByOther = task.status === 'locked' && !lockedByMe;

      previewTasks.push({
        taskId: String(task._id),
        productId: String(product._id),
        productTitle: getProductTitle(product),
        imageUrl,
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        totalQty,
        shopCount: (task.items || []).length,
        status: task.status,
        lockedBy,
        lockedByOther,
      });
    }

    res.json({ tasks: previewTasks });
  } catch (err) {
    console.error('[picking/block-tasks]', err);
    next(appError('picking_block_tasks_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/queue-stats?deliveryGroupId=...
// Live queue counters for UI (pending/locked split).
// ---------------------------------------------------------------------------
router.get('/queue-stats', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;

    if (!deliveryGroupId) {
      return res.json({ pendingCount: 0, lockedByMeCount: 0, lockedByOtherCount: 0, activeCount: 0 });
    }

    // Queue polling must NOT release current worker's active lock.
    // Otherwise the worker gets `expired_lock` while completing a task.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId, { releaseOwnLocks: false });

    const base = { deliveryGroupId: String(deliveryGroupId) };

    const [pendingCount, lockedByMeCount, lockedByOtherCount] = await Promise.all([
      PickingTask.countDocuments({ ...base, status: 'pending' }),
      PickingTask.countDocuments({ ...base, status: 'locked', lockedBy: String(user.telegramId) }),
      PickingTask.countDocuments({ ...base, status: 'locked', lockedBy: { $ne: String(user.telegramId) } }),
    ]);

    const activeCount = pendingCount + lockedByMeCount + lockedByOtherCount;
    res.json({ pendingCount, lockedByMeCount, lockedByOtherCount, activeCount });
  } catch (err) {
    console.error('[picking/queue-stats]', err);
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

    const { completedTask, nextTask: nextRaw, wrappedAround: nwa } = await completePickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
      userFirstName:  user.firstName,
      userLastName:   user.lastName,
      userRole:       user.role,
      items,
      nextBlock,
    });

    const nextTaskData = nextRaw ? await buildTaskResponse(nextRaw, { wrappedAround: nwa }) : null;
    res.json({ message: 'Task completed', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/complete]', err);
    if (err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err.code === 'expired_lock') return next(appError('expired_lock'));
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
    if (String(task.lockedBy || '') !== String(user.telegramId || '')) return next(appError('expired_lock'));

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
    const taskId = String(req.params.taskId);

    // Lock prevents a worker who taps "Взяти" twice across the network from
    // both racing the Mongo findOneAndUpdate. The first wins, the second sees
    // status='locked' with lockedBy=themselves and gets the same task back.
    await withLock(`picking:${taskId}:claim`, async () => {
      const claimed = await PickingTask.findOneAndUpdate(
        { _id: taskId, status: 'pending' },
        { $set: { status: 'locked', lockedBy: user.telegramId, lockedAt: new Date() } },
        { new: true },
      );
      if (!claimed) {
        const existing = await PickingTask.findById(taskId).lean();
        if (!existing) return next(appError('picking_claim_unavailable'));

        if (existing.status === 'locked' && String(existing.lockedBy || '') === String(user.telegramId || '')) {
          const mine = await buildTaskResponse(existing);
          if (mine) return res.json({ task: mine });
        }

        if (existing.status === 'locked') return next(appError('picking_claim_taken_by_other'));
        return next(appError('picking_claim_unavailable'));
      }

      const taskData = await buildTaskResponse(claimed);
      if (!taskData) {
        await PickingTask.findByIdAndUpdate(claimed._id, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
        return next(appError('picking_product_not_found'));
      }
      res.json({ task: taskData });
    }, { ttlMs: 10_000, waitMs: 5_000 });
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

    const { nextTask: nextRaw, wrappedAround: nwa } = await outOfStockPickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
      userFirstName:  user.firstName,
      userLastName:   user.lastName,
      userRole:       user.role,
      packedOrderIds,
      nextBlock,
    });

    const nextTaskData = nextRaw ? await buildTaskResponse(nextRaw, { wrappedAround: nwa }) : null;

    res.json({ message: 'Out-of-stock recorded', nextTask: nextTaskData });
  } catch (err) {
    console.error('[picking/out-of-stock]', err);
    next(appError('picking_oos_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/locked-tasks?deliveryGroupId=...
// Returns tasks currently locked by other workers (for end-of-queue UI).
// ---------------------------------------------------------------------------
router.get('/locked-tasks', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;

    const filter = {
      status: 'locked',
      lockedBy: { $ne: String(user.telegramId) },
      ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
    };

    const tasks = await PickingTask.find(
      filter,
      '_id productId blockId positionIndex lockedBy lockedAt items'
    ).lean();

    const productIds = [...new Set(tasks.map((t) => String(t.productId)))];
    const products = await Product.find(
      { _id: { $in: productIds } },
      'brand model category'
    ).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const result = tasks.map((task) => {
      const product = productMap.get(String(task.productId));
      return {
        taskId: String(task._id),
        productTitle: product
          ? (product.brand || product.model || product.category || '—')
          : '—',
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        lockedAt: task.lockedAt,
        shopCount: (task.items || []).length,
      };
    });

    res.json({ tasks: result });
  } catch (err) {
    console.error('[picking/locked-tasks]', err);
    next(appError('picking_next_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/tasks/:taskId/force-claim
// Force-release a stale lock and claim the task for the current worker.
// Only allowed if the task has been locked for more than FORCE_CLAIM_AFTER_MS.
// ---------------------------------------------------------------------------
router.post('/tasks/:taskId/force-claim', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;

    const { task: claimed } = await forceClaimPickingTask({
      taskId: req.params.taskId,
      userTelegramId: user.telegramId,
    });

    const taskData = await buildTaskResponse(claimed);
    if (!taskData) return next(appError('picking_product_not_found'));
    res.json({ task: taskData });
  } catch (err) {
    if (err.code === 'picking_claim_too_soon') {
      return res.status(409).json({
        code: 'picking_claim_too_soon',
        message: `Задача заблокована ${Math.round((err.lockedAgo || 0) / 1000)} с тому. Перехоплення доступне після 3 хвилин.`,
      });
    }
    console.error('[picking/force-claim]', err);
    if (err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err.code === 'picking_claim_unavailable') return next(appError('picking_claim_unavailable'));
    next(appError('picking_claim_failed'));
  }
});

module.exports = router;
