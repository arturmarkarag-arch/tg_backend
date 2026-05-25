const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { isOrderingOpen, getWarsawNow, DAY_FULL_UK, getOrderingWindowCloseAt } = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const cache = require('../utils/cache');
const { invalidateDeliveryGroup } = require('../utils/modelCache');

// Every write to a DeliveryGroup (here: pickingConfirmedAt) must bust BOTH the
// per-id model cache (dg:<id>, read by orders.js/getDeliveryGroup) AND the
// full-list cache (KEYS.DELIVERY_GROUPS, read by dashboards). Without this the
// picking dashboard / ordering window serve a stale confirmed-state for up to
// 10 min across workers. Best-effort: a cache miss must never break picking.
async function bustGroupCaches(id) {
  try {
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    await invalidateDeliveryGroup(id);
  } catch (e) {
    console.warn('[picking] delivery-group cache bust failed:', e.message);
  }
}

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
    if (err && err.name === 'AppError') return next(err);
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
    const { deliveryGroupId = null, confirm = false } = req.body;
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
        // Reset confirmed flag so next picking session starts fresh
        await DeliveryGroup.updateOne({ _id: deliveryGroupId }, { $set: { pickingConfirmedAt: null } });
        await bustGroupCaches(deliveryGroupId);
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
      currentSessionId = await getOrCreateSessionId(String(deliveryGroupId), groupForSession.dayOfWeek, schedule);
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
    const completedCount = existingActiveCount === 0
      ? await PickingTask.countDocuments({ status: 'completed', deliveryGroupId: String(deliveryGroupId) })
      : 0;

    if (existingActiveCount > 0 || completedCount > 0) {
      const inProgressCount = existingActiveCount > 0
        ? await PickingTask.countDocuments({
            status: { $in: ['locked', 'completed'] },
            deliveryGroupId: String(deliveryGroupId),
          })
        : 0;
      if (confirm) {
        await DeliveryGroup.updateOne({ _id: deliveryGroupId }, { $set: { pickingConfirmedAt: new Date() } });
        await bustGroupCaches(deliveryGroupId);
      }
      // When all tasks are completed (none pending/locked), the session is done — treat as confirmed
      // so the frontend shows 'ready' state instead of showing "Розпочати збирання" again.
      const confirmedGroup = await DeliveryGroup.findById(deliveryGroupId, 'pickingConfirmedAt').lean();
      const sessionConfirmed = !!(confirmedGroup?.pickingConfirmedAt) || completedCount > 0;
      return res.json({ alreadyStarted: true, taskCount: availableCount, sessionActive: inProgressCount > 0, sessionConfirmed });
    }

    // Without explicit confirmation, don't build tasks — user must press the button.
    if (!confirm) {
      return res.json({ preStart: true });
    }

    // 3. Detect stale orders from previous sessions.
    // These orders should NOT block warehouse flow; admins resolve them separately.
    const group2 = groupForSession;
    if (group2) {
      if (!currentSessionId) {
        const schedule2 = await getOrderingSchedule();
        currentSessionId = await getOrCreateSessionId(String(deliveryGroupId), group2.dayOfWeek, schedule2);
      }

      // BLOCK start while there are UNRESOLVED conflicts: a shop in THIS group's
      // CURRENT session holding active orders from 2+ distinct buyers (two sellers'
      // orders collided on one shop). Picking must not begin until staff resolve
      // them (move/unassign a seller) via the conflict panel. Same definition as
      // GET /v1/orders/conflicts, scoped to this group+session. The client already
      // renders this response (usePickingSession → 'unresolved_conflicts').
      const sessionActiveOrders = await Order.find(
        {
          'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
          status: { $in: ['new', 'in_progress'] },
          orderingSessionId: currentSessionId,
        },
        '_id shopId buyerSnapshot buyerTelegramId orderNumber',
      ).lean();

      const ordersByShop = new Map();
      for (const o of sessionActiveOrders) {
        const sid = String(o.shopId || o.buyerSnapshot?.shopId || '');
        if (!sid) continue;
        if (!ordersByShop.has(sid)) ordersByShop.set(sid, []);
        ordersByShop.get(sid).push(o);
      }
      const conflictShopIds = [...ordersByShop.entries()]
        .filter(([, orders]) => new Set(orders.map((o) => String(o.buyerTelegramId))).size > 1)
        .map(([sid]) => sid);

      if (conflictShopIds.length > 0) {
        const conflicts = [];
        for (const sid of conflictShopIds) {
          for (const o of ordersByShop.get(sid)) {
            conflicts.push({
              orderId: String(o._id),
              orderNumber: o.orderNumber,
              shopName: o.buyerSnapshot?.shopName || '—',
              shopCity: o.buyerSnapshot?.shopCity || '',
            });
          }
        }
        // Do NOT build tasks or mark confirmed — staff must resolve first.
        return res.json({ unresolved: true, conflicts });
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
      await DeliveryGroup.updateOne({ _id: deliveryGroupId }, { $set: { pickingConfirmedAt: new Date() } });
      await bustGroupCaches(deliveryGroupId);
      return res.json({ started: true, taskCount, staleWarnings });
    }

    // Reaching here means deliveryGroupId did not resolve to a real DeliveryGroup.
    // In the clean architecture every picking session is scoped to a real group +
    // ordering session, so this is an error — we never silently build tasks from
    // ALL active orders without session scoping (the removed legacy fallback).
    throw appError('group_not_found');
  } catch (err) {
    if (err && err.name === 'AppError') return next(err);
    console.error('[picking/start-session]', err);
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// GET /api/picking/my-task?deliveryGroupId=...
// Returns the worker's currently locked task without releasing anything.
// Used on page load to restore interrupted picking sessions.
// ---------------------------------------------------------------------------
router.get('/my-task', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const deliveryGroupId = req.query.deliveryGroupId || null;

    const task = await PickingTask.findOne({
      status: 'locked',
      lockedBy: String(user.telegramId),
      ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
    }).lean();

    if (!task) return res.json({ task: null });

    const taskData = await buildTaskResponse(task);
    if (!taskData) return res.json({ task: null });

    res.json({ task: taskData });
  } catch (err) {
    if (err && err.name === 'AppError') return next(err);
    next(appError('picking_next_failed'));
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
    if (err && err.name === 'AppError') return next(err);
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

    // Fetch names for workers who locked tasks
    const lockerIds = [...new Set(tasks.filter((t) => t.lockedBy).map((t) => String(t.lockedBy)))];
    const lockers = lockerIds.length
      ? await User.find({ telegramId: { $in: lockerIds } }, 'telegramId firstName lastName').lean()
      : [];
    const lockerNameMap = new Map(lockers.map((u) => [
      String(u.telegramId),
      [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.telegramId),
    ]));

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
        lockedAt: task.lockedAt ? task.lockedAt.toISOString() : null,
        lockedByName: lockedByOther && lockedBy ? (lockerNameMap.get(lockedBy) || null) : null,
      });
    }

    res.json({ tasks: previewTasks });
  } catch (err) {
    if (err && err.name === 'AppError') return next(err);
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
    if (err && err.name === 'AppError') return next(err);
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
    if (err && err.name === 'AppError') return next(err);
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
    const newItems = task.items.map((it) => {
      const plain = typeof it.toObject === 'function' ? it.toObject() : { ...it };
      plain.packed = packedSet.has(String(it.orderId));
      return plain;
    });

    // Atomic compare-and-swap: only writes if WE still hold the lock AND the
    // task hasn't been modified since we read it (__v). Closes the lost-update
    // race between two saves and the lock-stolen-mid-save (force-claim) TOCTOU.
    // Refreshing lockedAt also acts as a heartbeat so an actively-saving worker
    // is not force-claimed.
    const updated = await PickingTask.findOneAndUpdate(
      {
        _id: task._id,
        status: 'locked',
        lockedBy: String(user.telegramId || ''),
        __v: task.__v,
      },
      { $set: { items: newItems, lockedAt: new Date() }, $inc: { __v: 1 } },
      { new: true },
    );
    if (!updated) return next(appError('expired_lock'));

    res.json({ ok: true });
  } catch (err) {
    if (err && err.name === 'AppError') return next(err);
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
    if (err && err.name === 'AppError') return next(err);
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
    if (err && err.name === 'AppError') return next(err);
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
// GET /api/picking/shift-board?deliveryGroupId=...
// Live "shift board": who is working, how many tasks each person completed,
// session start time, last activity time.
// ---------------------------------------------------------------------------
router.get('/shift-board', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const { deliveryGroupId } = req.query;
    if (!deliveryGroupId) return res.json({ workers: [], totalCompleted: 0, totalPending: 0, sessionStart: null, lastActivity: null, groupName: '' });

    const dgId = String(deliveryGroupId);

    // Group name + session start time
    const group = await DeliveryGroup.findById(dgId, 'name pickingConfirmedAt').lean();
    const groupName = group?.name || '';
    const sessionStart = group?.pickingConfirmedAt || null;

    // Active workers (currently have a locked task)
    const lockedTasks = await PickingTask.find(
      { deliveryGroupId: dgId, status: 'locked', lockedBy: { $ne: null } },
      'lockedBy lockedAt',
    ).lean();
    const activeWorkerIds = new Set(lockedTasks.map((t) => String(t.lockedBy)));

    // Task counts per worker from completed tasks (updatedAt = completion time)
    const completedTasks = await PickingTask.find(
      { deliveryGroupId: dgId, status: 'completed' },
      'updatedAt',
    ).lean();
    const totalCompleted = completedTasks.length;
    const totalPending = await PickingTask.countDocuments({ deliveryGroupId: dgId, status: 'pending' });
    const lastActivity = completedTasks.length
      ? completedTasks.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), completedTasks[0].updatedAt)
      : null;

    // Per-worker stats: aggregate from Order.history (who packed via picking)
    // Scoped to orders in this delivery group fulfilled today.
    const workerStats = await Order.aggregate([
      { $match: { 'buyerSnapshot.deliveryGroupId': dgId, status: { $in: ['fulfilled', 'in_progress', 'new'] } } },
      { $unwind: '$history' },
      { $match: { 'history.action': 'status_changed', 'history.meta.via': 'picking', 'history.by': { $exists: true, $ne: '' } } },
      { $group: { _id: '$history.by', name: { $first: '$history.byName' }, tasksCompleted: { $sum: 1 } } },
    ]);

    // Merge with User collection for name fallback
    const workerIds = workerStats.map((w) => w._id);
    const activeIdsWithNoStats = [...activeWorkerIds].filter((id) => !workerIds.includes(id));
    const allWorkerIds = [...new Set([...workerIds, ...activeIdsWithNoStats])];

    const users = allWorkerIds.length
      ? await User.find({ telegramId: { $in: allWorkerIds } }, 'telegramId firstName lastName').lean()
      : [];
    const userNameMap = new Map(users.map((u) => [
      String(u.telegramId),
      [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.telegramId),
    ]));

    const statsMap = new Map(workerStats.map((w) => [w._id, w]));

    const workers = allWorkerIds.map((id) => {
      const stat = statsMap.get(id);
      return {
        telegramId: id,
        name: stat?.name || userNameMap.get(id) || id,
        tasksCompleted: stat?.tasksCompleted || 0,
        isActive: activeWorkerIds.has(id),
      };
    }).sort((a, b) => b.tasksCompleted - a.tasksCompleted || (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));

    res.json({ groupName, sessionStart, lastActivity, workers, totalCompleted, totalPending });
  } catch (err) {
    console.error('[picking/shift-board]', err);
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
    if (err && err.name === 'AppError') return next(err);
    console.error('[picking/force-claim]', err);
    if (err.code === 'picking_task_not_found') return next(appError('picking_task_not_found'));
    if (err.code === 'picking_claim_unavailable') return next(appError('picking_claim_unavailable'));
    next(appError('picking_claim_failed'));
  }
});

module.exports = router;
