'use strict';

/**
 * Core picking business logic — extracted from routes/picking.js so it can be
 * tested independently of Express and can be called from other services.
 */

const mongoose = require('mongoose');
const PickingTask = require('../models/PickingTask');
const Product     = require('../models/Product');
const Order       = require('../models/Order');
const DeliveryGroup = require('../models/DeliveryGroup');
const { archiveProduct, getProductTitle } = require('./archiveProduct');
const { getCurrentOrderingSessionId } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { getIO } = require('../socket');

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS      = 15 * 60 * 1000; // 15 min — stale worker lock
const FORCE_CLAIM_AFTER_MS =  3 * 60 * 1000; //  3 min — force-claim guard

// ── Retry helpers ────────────────────────────────────────────────────────────

function isTransientTxError(err) {
  const directLabels  = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  const symbolLabels  = Object.getOwnPropertySymbols(err || {})
    .filter((sym) => String(sym).includes('errorLabels'))
    .flatMap((sym) => Array.from(err[sym] || []));
  const labels = [...directLabels, ...symbolLabels];

  return (
    err?.code === 112 ||
    err?.codeName === 'WriteConflict' ||
    labels.includes('TransientTransactionError') ||
    err?.hasErrorLabel?.('TransientTransactionError')
  );
}

async function runTransactionWithRetry(work, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => { await work(session); });
      return;
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    } finally {
      await session.endSession();
    }
  }
}

async function runOperationWithRetry(work, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  return null;
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Mark Order items as packed for a given product and auto-fulfil the Order
 * when every non-cancelled item is packed.
 */
async function markOrderItemsPacked(taskItems, productId, actor = { by: 'system', byName: '', byRole: 'system' }, session = null) {
  const opts    = session ? { session } : {};
  const orderIds = [...new Set(taskItems.filter((i) => i.packed).map((i) => String(i.orderId)))];

  await Promise.all(
    orderIds.map(async (orderId) => {
      const result = await Order.updateOne(
        { _id: orderId, 'items.productId': productId },
        { $set: { 'items.$.packed': true } },
        opts,
      );
      if (result.matchedCount === 0) return;

      await Order.updateOne(
        {
          _id: orderId,
          status: { $in: ['new', 'in_progress'] },
          items: { $not: { $elemMatch: { packed: false, cancelled: false } } },
        },
        {
          $set: { status: 'fulfilled' },
          $push: { history: { at: new Date(), ...actor, action: 'status_changed', meta: { from: 'in_progress', to: 'fulfilled', via: 'picking' } } },
        },
        opts,
      );

      // Notify connected clients so the order board updates in real time
      try {
        const order = await Order.findById(orderId, 'buyerTelegramId').lean();
        const io = getIO();
        io.emit('order_updated', { orderId, buyerTelegramId: order?.buyerTelegramId });
        if (order?.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: order.buyerTelegramId });
      } catch { /* non-critical — socket may not be initialised in test env */ }
    })
  );
}

/**
 * Atomically find and lock the next pending task for a worker.
 * Pass 1: fromBlock → end; Pass 2: 1 → fromBlock-1 (wrap-around).
 */
async function findAndLockNext(userTelegramId, fromBlock, deliveryGroupId = null) {
  const lock = { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } };
  const opts = { sort: { blockId: 1, positionIndex: 1 }, new: true };
  const fresh = { status: 'pending' };
  if (deliveryGroupId) fresh.deliveryGroupId = String(deliveryGroupId);

  let task = await PickingTask.findOneAndUpdate({ ...fresh, blockId: { $gte: fromBlock } }, lock, opts);
  if (task) return { task, wrappedAround: false };

  if (fromBlock > 1) {
    task = await PickingTask.findOneAndUpdate(
      { ...fresh, blockId: { $gte: 1, $lt: fromBlock } }, lock, opts,
    );
    if (task) return { task, wrappedAround: true };
  }

  return { task: null, wrappedAround: false };
}

/**
 * Release a worker's own lock plus any stale lock older than LOCK_TIMEOUT_MS.
 * Set releaseOwnLocks=false when called from queue-stats polling.
 */
async function releaseWorkerAndStaleLocks(userTelegramId, deliveryGroupId = null, { releaseOwnLocks = true } = {}) {
  const staleLockedAt = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const conditions = [{ lockedAt: { $lt: staleLockedAt } }];
  if (releaseOwnLocks && userTelegramId) conditions.unshift({ lockedBy: String(userTelegramId) });

  await PickingTask.updateMany(
    {
      status: 'locked',
      ...(deliveryGroupId ? { deliveryGroupId: String(deliveryGroupId) } : {}),
      $or: conditions,
    },
    { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
  );
}

/**
 * Complete a picking task: record packed quantities, mark orders, advance to next task.
 *
 * @param {object} opts
 * @param {string}   opts.taskId
 * @param {string}   opts.userTelegramId
 * @param {string}   opts.userFirstName
 * @param {string}   opts.userLastName
 * @param {string}   opts.userRole
 * @param {Array}    opts.items          — [{ orderId, actualQty }]
 * @param {number}   [opts.nextBlock]
 *
 * @returns {{ completedTask, nextTask: object|null }}
 */
async function completePickingTask({ taskId, userTelegramId, userFirstName = '', userLastName = '', userRole = 'warehouse', items = [], nextBlock }) {
  const task = await PickingTask.findById(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });
  if (String(task.lockedBy || '') !== String(userTelegramId)) throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });

  // Apply actual packed quantities
  for (const taskItem of task.items) {
    const input = items.find((i) => String(i.orderId) === String(taskItem.orderId));
    if (input !== undefined) {
      taskItem.packedQuantity = Math.max(0, Number(input.actualQty) || 0);
    } else {
      taskItem.packedQuantity = taskItem.quantity;
    }
    taskItem.packed = taskItem.packedQuantity > 0;
  }

  task.status   = 'completed';
  task.lockedBy = null;
  task.lockedAt = null;

  const actor = { by: String(userTelegramId), byName: [userFirstName, userLastName].filter(Boolean).join(' '), byRole: userRole };

  await runTransactionWithRetry(async (session) => {
    await task.save({ session });
    await markOrderItemsPacked(task.items, task.productId, actor, session);
  });

  const fromBlock = typeof nextBlock === 'number' ? nextBlock : task.blockId;
  const { task: nextRaw, wrappedAround } = await findAndLockNext(userTelegramId, fromBlock, task.deliveryGroupId || null);

  return { completedTask: task.toObject(), nextTask: nextRaw ? nextRaw.toObject() : null, wrappedAround };
}

/**
 * Mark a task as out-of-stock: record which shops were served, archive the product.
 *
 * @returns {{ nextTask: object|null }}
 */
async function outOfStockPickingTask({ taskId, userTelegramId, userFirstName = '', userLastName = '', userRole = 'warehouse', packedOrderIds = [], nextBlock }) {
  let task = await PickingTask.findById(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });

  // Idempotency: task already completed (crashed after phase 1) — just retry archive
  if (task.status === 'completed') {
    const productForRetry = await Product.findById(task.productId);
    if (productForRetry && productForRetry.status !== 'archived') {
      await runOperationWithRetry(() => archiveProduct(productForRetry, { notifyBuyers: false, bot: null }));
    }
    const fromBlockRetry = typeof nextBlock === 'number' ? nextBlock : task.blockId;
    const { task: nextRaw, wrappedAround } = await findAndLockNext(userTelegramId, fromBlockRetry, task.deliveryGroupId || null);
    return { nextTask: nextRaw ? nextRaw.toObject() : null, wrappedAround };
  }

  // Auto-claim if still pending (called from review list)
  if (task.status === 'pending') {
    const claimed = await PickingTask.findOneAndUpdate(
      { _id: task._id, status: 'pending' },
      { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } },
      { new: true },
    );
    if (!claimed) throw Object.assign(new Error('Task taken by another worker'), { code: 'picking_claim_taken_by_other' });
    task = claimed;
  } else if (String(task.lockedBy || '') !== String(userTelegramId)) {
    throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });
  }

  await task.populate('productId');

  const packedSet = new Set(packedOrderIds.map(String));
  for (const item of task.items) {
    const wasPacked = packedSet.has(String(item.orderId));
    item.packedQuantity = wasPacked ? item.quantity : 0;
    item.packed = wasPacked;
  }

  task.status   = 'completed';
  task.lockedBy = null;
  task.lockedAt = null;

  const actor = { by: String(userTelegramId), byName: [userFirstName, userLastName].filter(Boolean).join(' '), byRole: userRole };

  // Phase 1: atomic task + order update
  await runTransactionWithRetry(async (session) => {
    await task.save({ session });
    await markOrderItemsPacked(task.items, task.productId, actor, session);
  });

  // Phase 2: archive product (idempotent on retry via completed-status guard above)
  const productDoc = await Product.findById(task.productId._id || task.productId);
  if (productDoc && productDoc.status !== 'archived') {
    await runOperationWithRetry(() => archiveProduct(productDoc, { notifyBuyers: false, bot: null }));
  }

  const fromBlock = typeof nextBlock === 'number' ? nextBlock : task.blockId;
  const { task: nextRaw, wrappedAround } = await findAndLockNext(userTelegramId, fromBlock, task.deliveryGroupId || null);
  return { nextTask: nextRaw ? nextRaw.toObject() : null, wrappedAround };
}

/**
 * Force-claim a task locked by another worker (allowed only after FORCE_CLAIM_AFTER_MS).
 *
 * @returns {{ task: object }}
 */
async function forceClaimPickingTask({ taskId, userTelegramId }) {
  const task = await PickingTask.findById(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });

  if (task.status === 'pending') {
    const claimed = await PickingTask.findOneAndUpdate(
      { _id: task._id, status: 'pending' },
      { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } },
      { new: true },
    );
    if (!claimed) throw Object.assign(new Error('Task unavailable'), { code: 'picking_claim_unavailable' });
    return { task: claimed.toObject() };
  }

  if (task.status !== 'locked') throw Object.assign(new Error('Task unavailable'), { code: 'picking_claim_unavailable' });

  const lockedAgo = Date.now() - new Date(task.lockedAt).getTime();
  if (lockedAgo < FORCE_CLAIM_AFTER_MS) {
    const tooSoonErr = Object.assign(new Error(`Too soon: locked ${Math.round(lockedAgo / 1000)}s ago`), { code: 'picking_claim_too_soon', lockedAgo });
    throw tooSoonErr;
  }

  const claimed = await PickingTask.findOneAndUpdate(
    { _id: task._id, status: 'locked' },
    { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } },
    { new: true },
  );
  if (!claimed) throw Object.assign(new Error('Task unavailable'), { code: 'picking_claim_unavailable' });
  return { task: claimed.toObject() };
}

/**
 * Reconcile active tasks with one ordering session:
 * removes items belonging to orders outside the session, drops empty tasks.
 */
async function reconcileActiveTasksForSession(deliveryGroupId, orderingSessionId) {
  const groupId   = String(deliveryGroupId  || '');
  const sessionId = String(orderingSessionId || '');
  if (!groupId || !sessionId) return { deletedCount: 0, trimmedCount: 0 };

  const currentOrders = await Order.find(
    { 'buyerSnapshot.deliveryGroupId': groupId, status: { $in: ['new', 'in_progress'] }, orderingSessionId: sessionId },
    '_id',
  ).lean();
  const allowedOrderIds = new Set(currentOrders.map((o) => String(o._id)));

  const activeTasks = await PickingTask.find(
    { deliveryGroupId: groupId, status: { $in: ['pending', 'locked'] } },
    '_id status items',
  ).lean();

  if (!activeTasks.length) return { deletedCount: 0, trimmedCount: 0 };

  let deletedCount = 0;
  let trimmedCount = 0;
  const ops = [];

  for (const task of activeTasks) {
    const keptItems = (task.items || []).filter((it) => allowedOrderIds.has(String(it.orderId)));
    if (keptItems.length === (task.items || []).length) continue;

    if (!keptItems.length) {
      const hasPackedProgress = (task.items || []).some((it) => it.packed);
      if (hasPackedProgress) continue; // never delete a task with partial progress
      ops.push({ deleteOne: { filter: { _id: task._id, status: { $in: ['pending', 'locked'] } } } });
      deletedCount += 1;
    } else {
      ops.push({ updateOne: { filter: { _id: task._id, status: { $in: ['pending', 'locked'] } }, update: { $set: { items: keptItems } } } });
      trimmedCount += 1;
    }
  }

  if (ops.length) await PickingTask.bulkWrite(ops, { ordered: false });
  return { deletedCount, trimmedCount };
}

/**
 * Find completed tasks whose product was never archived after a crash.
 * Re-runs archiveProduct for each affected product.
 */
async function archiveOrphanedOutOfStockProducts(deliveryGroupId) {
  const groupId = String(deliveryGroupId || '');
  if (!groupId) return { fixedCount: 0 };

  const completedTasks = await PickingTask.find(
    { deliveryGroupId: groupId, status: 'completed' },
    'productId',
  ).sort({ updatedAt: -1 }).limit(200).lean();

  if (!completedTasks.length) return { fixedCount: 0 };

  const productIds = [...new Set(completedTasks.map((t) => String(t.productId)))];
  let fixedCount   = 0;

  await Promise.all(
    productIds.map(async (pid) => {
      try {
        const product = await Product.findOne({ _id: pid, status: { $ne: 'archived' } });
        if (!product) return;
        const activeTask = await PickingTask.findOne({ productId: product._id, status: { $in: ['pending', 'locked'] } }).lean();
        if (activeTask) return;
        await archiveProduct(product, { notifyBuyers: false, bot: null });
        fixedCount += 1;
      } catch (err) {
        console.warn(`[pickingService] orphan archive failed for ${pid}:`, err.message);
      }
    })
  );

  return { fixedCount };
}

module.exports = {
  LOCK_TIMEOUT_MS,
  FORCE_CLAIM_AFTER_MS,
  markOrderItemsPacked,
  findAndLockNext,
  releaseWorkerAndStaleLocks,
  completePickingTask,
  outOfStockPickingTask,
  forceClaimPickingTask,
  reconcileActiveTasksForSession,
  archiveOrphanedOutOfStockProducts,
  runTransactionWithRetry,
  runOperationWithRetry,
};
