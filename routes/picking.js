const express = require('express');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const User = require('../models/User');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { getProductTitle } = require('../services/archiveProduct');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { isOrderingOpen, getOrderingWindowCloseAt, getOrderingWindowOpenAt, getOpenDateWarsaw } = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { normalizeDeliveryGroup } = require('../utils/deliveryGroupHelpers');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { appError, asyncHandler } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { transitionPickingStatus, maybeCompleteSession } = require('../utils/sessionStatus');
const { getSessionVocab, deriveSessionPhase } = require('../utils/sessionVocab');

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

// Distinct products ordered in a group's CURRENT ordering session (active orders).
// Counts product "positions" (one per productId, matching task granularity), not
// units. Read-only: resolves the session via getOpenDateWarsaw + a findOne (no
// upsert) so a polling GET never mutates. Best-effort — returns 0 on any failure.
async function countOrderedPositions(deliveryGroupId) {
  try {
    const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek').lean();
    if (!group) return 0;
    const schedule = await getOrderingSchedule();
    const openDate = getOpenDateWarsaw(group.dayOfWeek, schedule);
    const session = await OrderingSession.findOne(
      { groupId: String(deliveryGroupId), openDate },
      '_id',
    ).lean();
    if (!session) return 0;
    const orders = await Order.find(
      {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ['new', 'in_progress'] },
        orderingSessionId: String(session._id),
      },
      'items.productId items.packed items.cancelled',
    ).lean();
    const products = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        if (it.packed || it.cancelled || !it.productId) continue;
        products.add(String(it.productId));
      }
    }
    return products.size;
  } catch (err) {
    console.warn('[picking/queue-stats] countOrderedPositions failed:', err?.message || err);
    return 0;
  }
}

// Derive the single UI phase for a session. Centralised so /start-session and
// /queue-stats can never disagree. "hasWork" is order-based for live phases and
// task-based for a completed session (its orders are already fulfilled, so an
// active-order count would wrongly read 0 and label a real cycle as idle).
async function computeSessionPhase({ deliveryGroupId, sessionId, pickingStatus, dayOfWeek, schedule }) {
  const windowOpen = isOrderingOpen(dayOfWeek, schedule).isOpen;
  let hasWork;
  if (pickingStatus === 'completed') {
    hasWork = (await PickingTask.countDocuments({ orderingSessionId: String(sessionId), status: 'completed' })) > 0;
  } else {
    hasWork = !!(await Order.exists({
      'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
      status: { $in: ['new', 'in_progress'] },
      orderingSessionId: String(sessionId),
    }));
  }
  return deriveSessionPhase({ pickingStatus, windowOpen, hasWork });
}

// Summary line shown under the status chip:
//   - completed phase → THIS session: { current:true, seq, openDate, orderCount }
//       "Сесія №X (Чт, 29.05) — зібрано N замовлень"
//   - idle phase      → the most recent PRIOR completed session (so an empty
//       just-rolled group still tells the operator the last cycle finished):
//       { current:false, ... } or null if there is no prior numbered session.
//   - any other phase → null (the chip + live counters already say enough).
async function buildSessionSummary(phase, { deliveryGroupId, sessionId, session }) {
  if (phase === 'completed') {
    const orderCount = await Order.countDocuments({
      orderingSessionId: String(sessionId), status: 'fulfilled',
    });
    return { current: true, seq: session?.seq ?? null, openDate: session?.openDate ?? null, orderCount };
  }
  if (phase === 'idle') {
    const last = await OrderingSession.findOne(
      { groupId: String(deliveryGroupId), pickingStatus: 'completed', seq: { $ne: null }, _id: { $ne: sessionId } },
      'seq openDate',
    ).sort({ openDate: -1 }).lean();
    if (!last) return null;
    const orderCount = await Order.countDocuments({
      orderingSessionId: String(last._id), status: 'fulfilled',
    });
    return { current: false, seq: last.seq, openDate: last.openDate, orderCount };
  }
  return null;
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
 * Keep active tasks aligned with one ordering session.
 * Removes task items that belong to orders outside the target session and
 * drops empty active tasks so old sessions cannot block a new picking start.
 */

// ---------------------------------------------------------------------------
// GET /api/picking/session-status?groupId=...
// Lightweight: returns only pickingStatus for the current session of a group.
// Used by the seller catalog to hide "ordered" badge once picking has started.
// ---------------------------------------------------------------------------
router.get('/session-status', requireTelegramRoles(['warehouse', 'admin', 'seller']), asyncHandler(async (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.json({ pickingStatus: 'pending' });
  const group = await DeliveryGroup.findById(groupId, 'dayOfWeek').lean();
  if (!group) return res.json({ pickingStatus: 'pending' });
  const schedule = await getOrderingSchedule();
  const sessionId = await getOrCreateSessionId(String(groupId), group.dayOfWeek, schedule);
  const session = await OrderingSession.findById(sessionId, 'pickingStatus').lean();
  res.json({ pickingStatus: session?.pickingStatus || 'pending' });
}));

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
// Body: { deliveryGroupId, confirm? }
//
// Detection is SESSION-SCOPED: every decision is derived from the
// OrderingSession document (pickingStatus + events) plus tasks filtered by
// orderingSessionId. There is no `updatedAt >= sessionOpenAt` heuristic and no
// DeliveryGroup.pickingConfirmedAt — both were the source of the cross-session
// leak that stranded late orders when the admin changed the delivery day.
// ---------------------------------------------------------------------------
router.post('/start-session', requireTelegramRoles(['warehouse', 'admin']), async (req, res, next) => {
  try {
    const user = req.telegramUser;
    const { deliveryGroupId = null, confirm = false } = req.body;
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
    }

    const actor = {
      by: String(user.telegramId || ''),
      byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    };

    // 1. Ordering window — picking blocked while sellers can still place orders.
    const group = normalizeDeliveryGroup(await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean());
    if (!group) throw appError('group_not_found');

    const schedule = await getOrderingSchedule();
    const { isOpen, message } = isOrderingOpen(group.dayOfWeek, schedule);
    if (isOpen) {
      const windowCloseAt = getOrderingWindowCloseAt(group.dayOfWeek, schedule).toISOString();
      return res.json({ windowOpen: true, message, windowCloseAt });
    }
    // Window closed → picking allowed for the whole dead-time until the next
    // window opens; session identity (groupId + openDate) stays the same.

    // 2. Resolve session, free this worker's stale locks, archive orphans,
    //    drop tasks whose orders no longer belong to the current session.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId);
    const currentSessionId = await getOrCreateSessionId(String(deliveryGroupId), group.dayOfWeek, schedule);
    await archiveOrphanedOutOfStockProducts(deliveryGroupId);
    await reconcileActiveTasksForSession(deliveryGroupId, currentSessionId);

    // 3. Late-order absorption. If picking already left `pending` and new
    //    same-session orders arrived, materialise them as tasks and reopen the
    //    session if needed. This is the structural fix for the "8 stranded
    //    items" bug — detection is membership-based, not time-based.
    let session = await OrderingSession.findById(currentSessionId).lean();
    if (session && session.pickingStatus !== 'pending') {
      await buildPickingTasksFromOrders(deliveryGroupId, { orderingSessionId: currentSessionId });
      const newActiveCount = await PickingTask.countDocuments({
        orderingSessionId: currentSessionId,
        status: { $in: ['pending', 'locked'] },
      });
      if (newActiveCount > 0 && session.pickingStatus === 'completed') {
        // allowReopen flips completed → in_progress so the UI shows work pending.
        const reopened = await transitionPickingStatus(
          currentSessionId, 'in_progress',
          { actor, meta: { reason: 'late_order_absorbed' }, allowReopen: true },
        );
        if (reopened) session = reopened.toObject ? reopened.toObject() : reopened;
      }
    }

    const sessionActiveCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: { $in: ['pending', 'locked'] },
    });
    const sessionPendingCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: 'pending',
    });

    const recentEvents = (session?.events || []).slice(-10);
    // Window is closed here (the isOpen branch returned above), so phase derives
    // from pickingStatus + whether the session has real work.
    const basePhase = await computeSessionPhase({
      deliveryGroupId,
      sessionId: currentSessionId,
      pickingStatus: session?.pickingStatus || 'pending',
      dayOfWeek: group.dayOfWeek,
      schedule,
    });
    const baseSummary = await buildSessionSummary(basePhase, {
      deliveryGroupId, sessionId: currentSessionId, session,
    });
    // vocab travels with the events so the UI never hardcodes status/event
    // labels — backend stays the single source of truth for the enum + labels.
    // Payload is ~500 bytes and start-session is not a hot path.
    const baseEnvelope = {
      pickingStatus: session?.pickingStatus || 'pending',
      phase: basePhase,
      sessionSummary: baseSummary,
      groupDayOfWeek: group.dayOfWeek,
      events: recentEvents,
      vocab: getSessionVocab(),
    };

    // 4. Branch on session status. Frontend keeps its existing envelope keys
    //    (windowOpen / preStart / alreadyStarted / started / noOrders / unresolved)
    //    so usePickingSession does not have to change.
    if (session && session.pickingStatus !== 'pending') {
      // Already confirmed at some point — never show pre_start again.
      return res.json({
        alreadyStarted: true,
        taskCount: sessionPendingCount,
        sessionActive: session.pickingStatus === 'in_progress',
        sessionConfirmed: true,
        ...baseEnvelope,
      });
    }

    if (!confirm) {
      // Pending session, button not pressed yet.
      return res.json({ preStart: true, ...baseEnvelope });
    }

    // 5. Confirm flow — block on unresolved cross-seller conflicts.
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
      return res.json({ unresolved: true, conflicts, ...baseEnvelope });
    }

    // 6. Stale-order warnings (informational; don't block start).
    const staleOrders = await Order.find(
      {
        'buyerSnapshot.deliveryGroupId': String(deliveryGroupId),
        status: { $in: ['new', 'in_progress'] },
        orderingSessionId: { $ne: currentSessionId },
      },
      'buyerSnapshot buyerTelegramId orderingSessionId',
    ).lean();
    const staleWarnings = staleOrders.map((o) => ({
      orderId: String(o._id),
      shopName: o.buyerSnapshot?.shopName || '—',
      shopCity: o.buyerSnapshot?.shopCity || '',
      buyerTelegramId: String(o.buyerTelegramId),
    }));

    // 7. Build tasks, then move pending → confirmed.
    await buildPickingTasksFromOrders(deliveryGroupId, { orderingSessionId: currentSessionId });
    const builtCount = await PickingTask.countDocuments({
      orderingSessionId: currentSessionId,
      status: 'pending',
    });

    const confirmed = await transitionPickingStatus(currentSessionId, 'confirmed', {
      actor, meta: { taskCount: builtCount },
    });
    const confirmedDoc = confirmed ? (confirmed.toObject ? confirmed.toObject() : confirmed) : null;

    if (builtCount === 0) {
      // Empty session — close it out immediately so reloads see noOrders.
      const completed = await maybeCompleteSession(currentSessionId, {
        actor, meta: { reason: 'empty' },
      });
      const finalDoc = completed
        ? (completed.toObject ? completed.toObject() : completed)
        : confirmedDoc;
      return res.json({
        noOrders: true,
        staleWarnings,
        pickingStatus: finalDoc?.pickingStatus || 'completed',
        phase: await computeSessionPhase({
          deliveryGroupId,
          sessionId: currentSessionId,
          pickingStatus: finalDoc?.pickingStatus || 'completed',
          dayOfWeek: group.dayOfWeek,
          schedule,
        }),
        events: (finalDoc?.events || []).slice(-10),
        vocab: getSessionVocab(),
      });
    }

    return res.json({
      started: true,
      taskCount: builtCount,
      staleWarnings,
      pickingStatus: confirmedDoc?.pickingStatus || 'confirmed',
      phase: await computeSessionPhase({
        deliveryGroupId,
        sessionId: currentSessionId,
        pickingStatus: confirmedDoc?.pickingStatus || 'confirmed',
        dayOfWeek: group.dayOfWeek,
        schedule,
      }),
      events: (confirmedDoc?.events || []).slice(-10),
      vocab: getSessionVocab(),
    });
  } catch (err) {
    if (err && err.name === 'AppError') return next(err);
    console.error('[picking/start-session]', err);
    next(appError('picking_session_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/picking/cancel-start
// Rolls back a confirmed (but not yet in_progress) session to pending.
// Blocked if any task has already been completed.
// Body: { deliveryGroupId }
// ---------------------------------------------------------------------------
router.post('/cancel-start', requireTelegramRoles(['warehouse', 'admin']), asyncHandler(async (req, res) => {
  const { deliveryGroupId } = req.body;
  if (!deliveryGroupId) throw appError('picking_delivery_group_required');

  const group = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek name').lean();
  if (!group) throw appError('group_not_found');

  const schedule = await getOrderingSchedule();
  const sessionId = await getOrCreateSessionId(String(deliveryGroupId), group.dayOfWeek, schedule);
  const session = await OrderingSession.findById(sessionId).lean();

  if (!session || session.pickingStatus !== 'confirmed') {
    return res.status(409).json({ error: 'Скасування можливе лише поки жоден товар ще не зібраний.' });
  }

  const completedCount = await PickingTask.countDocuments({
    orderingSessionId: String(sessionId),
    status: 'completed',
  });
  if (completedCount > 0) {
    return res.status(409).json({ error: 'Збирання вже розпочалось — є виконані завдання.' });
  }

  await PickingTask.deleteMany({ orderingSessionId: String(sessionId), status: { $in: ['pending', 'locked'] } });

  const actor = {
    by: String(req.telegramUser.telegramId || ''),
    byName: [req.telegramUser.firstName, req.telegramUser.lastName].filter(Boolean).join(' '),
  };
  await transitionPickingStatus(sessionId, 'pending', { actor, allowReopen: true });

  res.json({ ok: true, pickingStatus: 'pending' });
}));

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

    // deliveryGroupId is REQUIRED for next-task: this endpoint acquires a lock,
    // and findAndLockNext with a null group would lock the globally-next pending
    // task — potentially from a different delivery group the worker isn't picking.
    // Every real caller (per-group PickingPage) always sends it.
    if (!deliveryGroupId) {
      return next(appError('picking_delivery_group_required'));
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

    // Do NOT release the caller's own lock here. The block picker is polled every
    // 5s while open and is reachable from the toolbar WHILE a task is active
    // (ReadyToolbar renders even with a locked task). With releaseOwnLocks=true a
    // worker who opened the picker to glance at another block had their active
    // task quietly released mid-pick → another worker grabbed it → the first got
    // `expired_lock` on complete. Stale locks of OTHER workers are still swept.
    await releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId, { releaseOwnLocks: false });

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
    // orderedPositions = distinct products ordered in the CURRENT session (from Orders),
    // not built tasks. This is what the pre-start "Сумарно замовлено" banner shows: it
    // is meaningful before picking starts (tasks aren't built yet) and stays stable as
    // workers pack (pendingCount shrinks). Best-effort: never break queue polling.
    const orderedPositions = await countOrderedPositions(deliveryGroupId);

    // Live pickingStatus + last events so the SessionStatusHeader chip and
    // timeline refresh on the same 5-second poll the rest of the UI uses.
    // Without this the header is frozen on whatever /start-session returned at
    // mount: after the last task is packed and maybeCompleteSession flips the
    // session to 'completed', the chip would still read "Очікує підтвердження".
    let pickingStatus = null;
    let events = [];
    let phase = null;
    let sessionSummary = null;
    let groupDayOfWeek = null;
    try {
      const groupDoc = await DeliveryGroup.findById(deliveryGroupId, 'dayOfWeek').lean();
      if (groupDoc) {
        groupDayOfWeek = groupDoc.dayOfWeek;
        const schedule = await getOrderingSchedule();
        const sessionId = await getOrCreateSessionId(String(deliveryGroupId), groupDoc.dayOfWeek, schedule);
        const sessionDoc = await OrderingSession.findById(sessionId, 'pickingStatus events seq openDate').lean();
        if (sessionDoc) {
          pickingStatus = sessionDoc.pickingStatus || 'pending';
          events = (sessionDoc.events || []).slice(-10);
          phase = await computeSessionPhase({
            deliveryGroupId,
            sessionId,
            pickingStatus,
            dayOfWeek: groupDoc.dayOfWeek,
            schedule,
          });
          sessionSummary = await buildSessionSummary(phase, {
            deliveryGroupId, sessionId, session: sessionDoc,
          });
        }
      }
    } catch (e) {
      console.warn('[picking/queue-stats] session status fetch failed:', e.message);
    }

    res.json({
      pendingCount, lockedByMeCount, lockedByOtherCount, activeCount,
      orderedPositions, pickingStatus, events, phase, sessionSummary, groupDayOfWeek,
    });
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
router.get('/shift-board', requireTelegramRoles(['admin']), async (req, res, next) => {
  try {
    const { deliveryGroupId } = req.query;
    if (!deliveryGroupId) return res.json({ workers: [], totalCompleted: 0, totalPending: 0, sessionStart: null, lastActivity: null, groupName: '' });

    const dgId = String(deliveryGroupId);

    // Group name + session start time
    const group = await DeliveryGroup.findById(dgId, 'name dayOfWeek').lean();
    const groupName = group?.name || '';

    // Session start = when this picking session was confirmed. Lives on the
    // OrderingSession (not the group), so changing the delivery day cannot
    // stamp the start time of a future cycle onto a finished one.
    let sessionStart = null;
    let sessionId = null;
    if (group) {
      const schedule = await getOrderingSchedule();
      sessionId = await getOrCreateSessionId(dgId, group.dayOfWeek, schedule);
      const sessionDoc = await OrderingSession.findById(sessionId, 'pickingConfirmedAt').lean();
      sessionStart = sessionDoc?.pickingConfirmedAt || null;
    }
    const sessionScope = sessionId ? { orderingSessionId: sessionId } : { deliveryGroupId: dgId };

    // Active workers (currently have a locked task)
    const lockedTasks = await PickingTask.find(
      { deliveryGroupId: dgId, status: 'locked', lockedBy: { $ne: null } },
      'lockedBy lockedAt',
    ).lean();
    const activeWorkerIds = new Set(lockedTasks.map((t) => String(t.lockedBy)));

    // Completed-task counts scoped to the CURRENT session so finished cycles
    // do not keep inflating the board. Previously this was kept clean by a
    // deleteMany on start-session; with session stamping the filter does it
    // structurally and history survives.
    const completedTasks = await PickingTask.find(
      { ...sessionScope, status: 'completed' },
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
    const taskId = String(req.params.taskId);

    // Same lock key as the normal claim so a regular "Взяти" and a "Перехопити"
    // on the SAME task serialise against each other across all workers. The
    // pinned lockedBy/lockedAt filter inside forceClaimPickingTask is the
    // correctness backstop; this lock removes the contention window entirely.
    const { task: claimed } = await withLock(
      `picking:${taskId}:claim`,
      () => forceClaimPickingTask({ taskId, userTelegramId: user.telegramId }),
      { ttlMs: 10_000, waitMs: 5_000 },
    );

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
