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
const { getIO } = require('../socket');
const { withLock } = require('../utils/lock');
const { transitionPickingStatus, maybeCompleteSession } = require('../utils/sessionStatus');
const { buildUnreconciledOosTaskFilter } = require('../utils/pickingOosRecovery');

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS      =  5 * 60 * 1000;            //  5 min — stale worker lock
const FORCE_CLAIM_AFTER_MS =  3 * 60 * 1000;            //  3 min — force-claim guard
const COMPLETED_TTL_MS     = 90 * 24 * 60 * 60 * 1000;  // 90 days — completed-task retention (TTL)

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

const PICKING_TX_MAX_RETRIES = 6;
const PICKING_TX_RETRY_BASE_MS = 50;
const PICKING_TX_RETRY_CAP_MS = 800;

function transientRetryDelayMs(attempt) {
  // attempt=0 is the wait before the first retry. Exponential backoff keeps a
  // 12-worker burst from hammering the same shared Order documents in lockstep;
  // jitter prevents the contenders from waking up together again. The cap keeps
  // the worst-case warehouse click latency bounded.
  const exponential = Math.min(PICKING_TX_RETRY_CAP_MS, PICKING_TX_RETRY_BASE_MS * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 2)));
  return exponential + jitter;
}

async function runTransactionWithRetry(work, maxRetries = PICKING_TX_MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => { await work(session); });
      return;
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, transientRetryDelayMs(attempt)));
    } finally {
      await session.endSession();
    }
  }
}

async function runOperationWithRetry(work, maxRetries = PICKING_TX_MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      if (!isTransientTxError(err) || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, transientRetryDelayMs(attempt)));
    }
  }
  return null;
}

// A hot product task can touch dozens or hundreds of the SAME Order documents as
// other products being finished by other pickers. Mongo transactions are correct,
// but document-level write conflicts make a 12-worker burst repeatedly abort the
// losing transactions. Retrying harder only turns the warehouse click into a long
// lottery. Physical picking stays fully parallel; only the short fulfilment COMMIT
// lane is serialised per ordering session. The transaction remains the correctness
// boundary, this lock is contention shaping. Redis makes it distributed; the local
// fallback is sufficient for the supported single-process mode.
const PICKING_FINALIZE_LOCK_TTL_MS = 120_000;
const PICKING_FINALIZE_LOCK_WAIT_MS = 30_000;

async function withPickingFinalizeLock(orderingSessionId, work) {
  const sessionId = String(orderingSessionId || '');
  if (!sessionId) return work();
  return withLock(
    `picking:finalize:${sessionId}`,
    work,
    { ttlMs: PICKING_FINALIZE_LOCK_TTL_MS, waitMs: PICKING_FINALIZE_LOCK_WAIT_MS },
  );
}

// ── Core helpers ─────────────────────────────────────────────────────────────

// Only produce closure diagnostics once this session's live queue is empty.
// `maybeCompleteSession` keeps its historical OrderingSession|null contract; this
// helper is the separate visibility channel for the rare "queue is empty but the
// integrity gate still says no" case.
async function finalizeSessionAndGetBlockers(orderingSessionId, deliveryGroupId, actor = {}) {
  const sessionId = String(orderingSessionId || '');
  const groupId = String(deliveryGroupId || '');
  if (!sessionId || !groupId) return [];

  const completed = await maybeCompleteSession(sessionId, { actor });
  if (completed) return [];

  const [active, activeInExpectedGroup] = await Promise.all([
    PickingTask.countDocuments({
      orderingSessionId: sessionId,
      status: { $in: ['pending', 'locked'] },
    }),
    PickingTask.countDocuments({
      orderingSessionId: sessionId,
      deliveryGroupId: groupId,
      status: { $in: ['pending', 'locked'] },
    }),
  ]);
  // Normal live work is not a closure error worth spamming after every product.
  // But if session-owned active tasks exist OUTSIDE the expected group, do run the
  // audit: otherwise maybeCompleteSession is blocked by them and the worker sees
  // no explanation because the normal group queue is already empty.
  if (active > 0 && active === activeInExpectedGroup) return [];

  // Lazy import avoids the sessionClosure -> sessionCoverage -> archiveProduct ->
  // sessionStatus cycle at module initialisation time.
  const { auditSessionClosure } = require('./sessionClosure');
  const audit = await auditSessionClosure({
    deliveryGroupId: groupId,
    orderingSessionId: sessionId,
  });
  return Array.isArray(audit?.blockers) ? audit.blockers : [];
}

/**
 * Mark Order items as packed for a given product and auto-fulfil the Order
 * when every item is terminal (packed / cancelled / skipped / voided).
 */
async function markOrderItemsPacked(taskItems, productId, actor = { by: 'system', byName: '', byRole: 'system' }, session = null) {
  const opts    = session ? { session } : {};

  // Keep one entry PER ORDER (not just the id set): the delivered quantity has to
  // travel with it. A boolean `packed` cannot say "7 of the 10 ordered", so
  // without this the shortfall was lost the moment the task closed.
  const packedByOrder = new Map();
  for (const item of taskItems) {
    if (!item.packed) continue;
    packedByOrder.set(String(item.orderId), item);
  }
  const packedAt = new Date();

  await Promise.all(
    [...packedByOrder.entries()].map(async ([orderId, taskItem]) => {
      const ordered  = Number(taskItem.quantity) || 0;
      // packedQuantity is null only on legacy/system paths that never set it;
      // there "packed" still means the full ordered amount went out.
      const delivered = taskItem.packedQuantity == null ? ordered : Number(taskItem.packedQuantity) || 0;

      const result = await Order.updateOne(
        { _id: orderId, 'items.productId': productId },
        {
          $set: {
            'items.$.packed': true,
            'items.$.packedQuantity': delivered,
            'items.$.shortfallReason': delivered < ordered ? 'short_pick' : null,
            'items.$.packedBy': String(actor.by || ''),
            'items.$.packedByName': String(actor.byName || ''),
            'items.$.packedAt': packedAt,
          },
        },
        opts,
      );
      if (result.matchedCount === 0) return;

      await Order.updateOne(
        {
          _id: orderId,
          status: { $in: ['new', 'in_progress'] },
          // A `skipped` item (late, strict-missed) is terminal and must NOT keep an
          // order from auto-fulfilling — treat it like packed/cancelled here.
          items: { $not: { $elemMatch: { packed: false, cancelled: false, skipped: { $ne: true }, voided: { $ne: true } } } },
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
        if (order?.buyerTelegramId) io.emit('user_order_updated', { buyerTelegramId: order.buyerTelegramId });
      } catch { /* non-critical — socket may not be initialised in test env */ }
    })
  );
}

/**
 * Atomically advance a worker FORWARD inside ONE ordering session.
 *
 * Cursor = (blockId, positionIndex). We inspect the nearest still-active task
 * ahead. Completed tasks are naturally skipped. If the nearest active task is
 * locked by another worker, that worker is a PHYSICAL BARRIER: we do not jump
 * over them to 51/52/etc. The caller sends the picker back to block selection.
 *
 * There is deliberately NO wrap-around to previous positions/blocks. Old work
 * behind the cursor stays visible in review/repair flows, but automatic walking
 * never turns around.
 */
async function findAndLockNext(
  userTelegramId,
  fromBlock,
  deliveryGroupId = null,
  { orderingSessionId = null, fromPosition = 0, actor = {} } = {},
) {
  const groupId = deliveryGroupId ? String(deliveryGroupId) : '';
  const sessionId = orderingSessionId ? String(orderingSessionId) : '';
  const block = Number(fromBlock);
  const position = Math.max(0, Number(fromPosition) || 0);
  if (!groupId || !sessionId || !Number.isFinite(block)) {
    return { task: null, routeBlocked: null };
  }

  const uid = String(userTelegramId || '');
  const cursor = {
    $or: [
      { blockId: { $gt: block } },
      { blockId: block, positionIndex: { $gt: position } },
    ],
  };

  // Re-read after claim races. A candidate that another worker locks between our
  // read and update becomes the barrier on the next iteration; it is never skipped.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = await PickingTask.findOne({
      deliveryGroupId: groupId,
      orderingSessionId: sessionId,
      status: { $in: ['pending', 'locked'] },
      ...cursor,
    }).sort({ blockId: 1, positionIndex: 1 });

    if (!candidate) return { task: null, routeBlocked: null };

    if (candidate.status === 'locked') {
      if (String(candidate.lockedBy || '') === uid) {
        await markSessionInProgress(candidate.orderingSessionId, actor);
        return { task: candidate, routeBlocked: null };
      }
      return {
        task: null,
        routeBlocked: {
          code: 'worker_ahead',
          taskId: String(candidate._id),
          blockId: candidate.blockId,
          positionIndex: candidate.positionIndex,
          lockedBy: candidate.lockedBy ? String(candidate.lockedBy) : null,
          lockedAt: candidate.lockedAt || null,
        },
      };
    }

    const claimed = await PickingTask.findOneAndUpdate(
      {
        _id: candidate._id,
        status: 'pending',
        deliveryGroupId: groupId,
        orderingSessionId: sessionId,
      },
      { $set: { status: 'locked', lockedBy: uid, lockedAt: new Date() } },
      { new: true },
    );

    if (!claimed) continue;
    await releaseOtherLocksOfWorker(uid, claimed._id);
    await markSessionInProgress(claimed.orderingSessionId, actor);
    return { task: claimed, routeBlocked: null };
  }

  return { task: null, routeBlocked: { code: 'claim_race' } };
}

/**
 * Flip the session confirmed → in_progress the moment the FIRST task is locked.
 *
 * Picking starts when someone takes a product off the shelf, not when they
 * finish it. Until this existed the session sat at 'confirmed' while ten people
 * walked the warehouse, and `cancel-start` — which is gated on 'confirmed' —
 * would happily delete the work they were holding.
 *
 * Idempotent: transitionPickingStatus pins fromStatus='confirmed', so every
 * later lock matches nothing and pushes no duplicate event.
 */
async function markSessionInProgress(orderingSessionId, actor = {}) {
  if (!orderingSessionId) return null;
  return transitionPickingStatus(orderingSessionId, 'in_progress', { actor });
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
 * Enforce the one-task-per-worker invariant: release every OTHER task this
 * worker still holds, keeping `keepTaskId`.
 *
 * Deliberately NOT scoped by deliveryGroupId — a picker physically holds one
 * product at a time, so a lock left behind in another group is exactly the
 * orphan we are cleaning up. `items[].packed` is untouched, so the released
 * task returns to the queue with its partial progress intact.
 *
 * MUST be called only AFTER the new lock is secured. Releasing first and then
 * losing the claim race would leave the worker with nothing while their old
 * task goes back into the queue.
 *
 * @returns {Promise<string[]>} ids of the tasks that were released
 */
async function releaseOtherLocksOfWorker(userTelegramId, keepTaskId) {
  const uid = String(userTelegramId || '');
  if (!uid) return [];

  const filter = {
    status: 'locked',
    lockedBy: uid,
    ...(keepTaskId ? { _id: { $ne: keepTaskId } } : {}),
  };

  const stray = await PickingTask.find(filter, '_id').lean();
  if (!stray.length) return [];

  await PickingTask.updateMany(filter, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
  return stray.map((t) => String(t._id));
}

/**
 * Explicitly release the CURRENT task back to the queue without completing it.
 *
 * This is the intentional "I need to leave" path. Partial packed progress is
 * preserved, and the task becomes immediately claimable by another worker.
 * Only the worker who currently owns the lock may release it.
 *
 * packedOrderIds is accepted as the final authoritative checkbox snapshot so
 * the last UI state and the unlock can commit in one compare-and-swap.
 */
async function releasePickingTask({ taskId, userTelegramId, packedOrderIds = null }) {
  const uid = String(userTelegramId || '');
  const task = await PickingTask.findById(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });

  if (task.status === 'pending') {
    return { released: false, alreadyReleased: true, task: task.toObject() };
  }
  if (task.status !== 'locked') {
    throw Object.assign(new Error('Task unavailable'), { code: 'picking_release_unavailable' });
  }
  if (String(task.lockedBy || '') !== uid) {
    throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });
  }

  let items = task.items.map((it) => (typeof it.toObject === 'function' ? it.toObject() : { ...it }));
  if (Array.isArray(packedOrderIds)) {
    const packedSet = new Set(packedOrderIds.map(String));
    items = items.map((it) => ({ ...it, packed: packedSet.has(String(it.orderId)) }));
  }

  const released = await PickingTask.findOneAndUpdate(
    {
      _id: task._id,
      status: 'locked',
      lockedBy: uid,
      __v: task.__v,
    },
    {
      $set: {
        items,
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
      },
      $inc: { __v: 1 },
    },
    { new: true },
  );

  if (!released) {
    const current = await PickingTask.findById(task._id).lean();
    if (current?.status === 'pending') {
      return { released: false, alreadyReleased: true, task: current };
    }
    throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });
  }

  try {
    const io = getIO();
    io?.emit('picking_task_released', {
      taskId: String(released._id),
      deliveryGroupId: String(released.deliveryGroupId || ''),
      orderingSessionId: String(released.orderingSessionId || ''),
      blockId: released.blockId,
      positionIndex: released.positionIndex,
    });
  } catch { /* socket is non-critical / absent in tests */ }

  return { released: true, alreadyReleased: false, task: released.toObject() };
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
  // Cheap pre-check for a fast, clear error before opening a session.
  const pre = await PickingTask.findById(taskId).lean();
  if (!pre) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });
  if (String(pre.lockedBy || '') !== String(userTelegramId)) throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });

  const actor = { by: String(userTelegramId), byName: [userFirstName, userLastName].filter(Boolean).join(' '), byRole: userRole };

  let task;
  await withPickingFinalizeLock(pre.orderingSessionId, () => runTransactionWithRetry(async (session) => {
    // Re-read + re-verify the lock INSIDE the transaction. Between the pre-check
    // and here another worker may have force-claimed the task (lock stolen);
    // mutating a stale in-memory doc would silently overwrite their work.
    task = await PickingTask.findById(taskId).session(session);
    if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });
    if (String(task.lockedBy || '') !== String(userTelegramId)) throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });

    // The payload must describe EVERY shop of the task and nothing else.
    // Previously a missing orderId silently defaulted to "full quantity delivered",
    // so a truncated / stale request marked shops as fully served without anyone
    // having touched their box. A mismatch means the client's copy of the task is
    // stale (e.g. a late order was appended to it mid-pick) — refuse and let it
    // refetch rather than guess.
    const taskOrderIds  = new Set(task.items.map((i) => String(i.orderId)));
    const inputOrderIds = new Set(items.map((i) => String(i.orderId)));
    const sameCoverage =
      taskOrderIds.size === inputOrderIds.size &&
      [...taskOrderIds].every((id) => inputOrderIds.has(id));
    if (!sameCoverage) {
      throw Object.assign(
        new Error('Submitted shops do not match the task'),
        { code: 'picking_task_items_changed' },
      );
    }

    // Apply actual packed quantities
    for (const taskItem of task.items) {
      const input = items.find((i) => String(i.orderId) === String(taskItem.orderId));
      if (input !== undefined) {
        // Clamp to [0, ordered]: a picker can pack fewer (partial / out of
        // stock) but never MORE than was ordered. Without the upper cap a bad
        // actualQty (typo / fat-finger) propagates into order fulfilment and
        // downstream receipt/reporting as an impossible packed count.
        const ordered = Number(taskItem.quantity) || 0;
        taskItem.packedQuantity = Math.min(ordered, Math.max(0, Number(input.actualQty) || 0));
      } else {
        taskItem.packedQuantity = taskItem.quantity;
      }
      taskItem.packed = taskItem.packedQuantity > 0;
    }

    task.status   = 'completed';
    task.lockedBy = null;
    task.lockedAt = null;
    task.completionReason = 'packed';
    // Stamp the finaliser for session-scoped shift-board ranking (lockedBy is
    // about to be cleared, so this is the only surviving record of who picked it).
    task.completedBy     = String(userTelegramId);
    task.completedByName  = actor.byName;
    task.completedExpireAt = new Date(Date.now() + COMPLETED_TTL_MS); // TTL reap after 90d

    await task.save({ session });
    await markOrderItemsPacked(task.items, task.productId, actor, session);

    // First completion of this session flips it to "В роботі" (in_progress).
    // Idempotent: only confirmed → in_progress matches; later completions no-op.
    if (task.orderingSessionId) {
      await transitionPickingStatus(
        task.orderingSessionId, 'in_progress', { actor: { by: actor.by, byName: actor.byName } }, session,
      );
    }
  }));

  // After commit: close the session if possible. If the live queue is already
  // empty but integrity still blocks closure, surface those blockers to the worker
  // instead of silently returning null from maybeCompleteSession.
  const closureBlockers = await finalizeSessionAndGetBlockers(
    task.orderingSessionId,
    task.deliveryGroupId,
    { by: actor.by, byName: actor.byName },
  );

  const { task: nextRaw, routeBlocked } = await findAndLockNext(
    userTelegramId,
    task.blockId,
    task.deliveryGroupId || null,
    {
      orderingSessionId: task.orderingSessionId,
      fromPosition: task.positionIndex,
      actor: { by: actor.by, byName: actor.byName },
    },
  );

  return { completedTask: task.toObject(), nextTask: nextRaw ? nextRaw.toObject() : null, routeBlocked, closureBlockers };
}

/**
 * Mark a task as out-of-stock: record which shops were served, archive the product.
 *
 * @returns {{ nextTask: object|null }}
 */
async function outOfStockPickingTask({ taskId, userTelegramId, userFirstName = '', userLastName = '', userRole = 'warehouse', packedOrderIds = [], nextBlock }) {
  let task = await PickingTask.findById(taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });

  // Built up front: the crash-retry branch below archives too, and it must stamp
  // the same picker on the affected orders' history as the normal path does.
  const actor = { by: String(userTelegramId), byName: [userFirstName, userLastName].filter(Boolean).join(' '), byRole: userRole };

  // Idempotency: task already completed (crashed after phase 1) — just retry archive.
  //
  // Gated on the RECORDED reason, never on status alone. 'completed' says the task
  // is finished, not why: replaying this request on a normally-packed task (stale
  // tab, duplicate submit, manual retry after a network blip) used to archive an
  // in-stock product. A retry is only a retry when the original was an OOS.
  if (task.status === 'completed') {
    if (task.completionReason !== 'out_of_stock') {
      throw Object.assign(
        new Error('Task was already completed as a normal pick'),
        { code: 'picking_oos_already_packed' },
      );
    }
    await withPickingFinalizeLock(task.orderingSessionId, async () => {
      const productForRetry = await Product.findById(task.productId);
      if (productForRetry && productForRetry.status !== 'archived') {
        // archiveProduct now retries transient tx errors internally.
        await archiveProduct(productForRetry, { notifyBuyers: false, bot: null, reason: 'out_of_stock', actor });
      }
    });
    const closureBlockers = await finalizeSessionAndGetBlockers(
      task.orderingSessionId, task.deliveryGroupId, { by: actor.by, byName: actor.byName },
    );
    const { task: nextRaw, routeBlocked } = await findAndLockNext(
      userTelegramId, task.blockId, task.deliveryGroupId || null,
      { orderingSessionId: task.orderingSessionId, fromPosition: task.positionIndex, actor },
    );
    return { nextTask: nextRaw ? nextRaw.toObject() : null, routeBlocked, closureBlockers };
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

  // Phase 1: atomic task + order update.
  // Re-read + re-verify the task INSIDE the transaction (mirrors the hardening
  // already in completePickingTask). Between the initial findById above and
  // here a concurrent progress-PATCH or force-claim may have mutated the task;
  // saving the stale in-memory doc would silently overwrite their work.
  await withPickingFinalizeLock(task.orderingSessionId, async () => {
    await runTransactionWithRetry(async (session) => {
      const fresh = await PickingTask.findById(task._id).session(session);
    if (!fresh) throw Object.assign(new Error('Task not found'), { code: 'picking_task_not_found' });
    // Finalised by a retry / other path between the findById above and here.
    // Same rule as the pre-check: only a prior OOS may fall through to phase 2,
    // otherwise this would archive a product someone just packed normally.
    if (fresh.status === 'completed') {
      if (fresh.completionReason !== 'out_of_stock') {
        throw Object.assign(
          new Error('Task was already completed as a normal pick'),
          { code: 'picking_oos_already_packed' },
        );
      }
      return;
    }
    if (String(fresh.lockedBy || '') !== String(userTelegramId)) {
      throw Object.assign(new Error('Lock expired'), { code: 'expired_lock' });
    }
    for (const item of fresh.items) {
      const wasPacked = packedSet.has(String(item.orderId));
      item.packedQuantity = wasPacked ? item.quantity : 0;
      item.packed = wasPacked;
    }
    fresh.status   = 'completed';
    fresh.lockedBy = null;
    fresh.lockedAt = null;
    fresh.completionReason = 'out_of_stock';
    // Out-of-stock is still a picker action — credit it on the shift board.
    fresh.completedBy     = String(userTelegramId);
    fresh.completedByName  = actor.byName;
    fresh.completedExpireAt = new Date(Date.now() + COMPLETED_TTL_MS); // TTL reap after 90d
    await fresh.save({ session });
    await markOrderItemsPacked(fresh.items, fresh.productId, actor, session);
    task = fresh; // keep downstream block/product lookups consistent

      if (fresh.orderingSessionId) {
        await transitionPickingStatus(
          fresh.orderingSessionId, 'in_progress', { actor: { by: actor.by, byName: actor.byName } }, session,
        );
      }
    });

    // Phase 2 belongs to the same fulfilment commit lane. archiveProduct also
    // rewrites Orders/Blocks/PickingTasks and must not race the next task's Order
    // fulfilment while this session is under a hot-product burst.
    const productDoc = await Product.findById(task.productId._id || task.productId);
    if (productDoc && productDoc.status !== 'archived') {
      await archiveProduct(productDoc, { notifyBuyers: false, bot: null, reason: 'out_of_stock', actor });
    }
  });

  const closureBlockers = await finalizeSessionAndGetBlockers(
    task.orderingSessionId, task.deliveryGroupId, { by: actor.by, byName: actor.byName },
  );

  const { task: nextRaw, routeBlocked } = await findAndLockNext(
    userTelegramId, task.blockId, task.deliveryGroupId || null,
    { orderingSessionId: task.orderingSessionId, fromPosition: task.positionIndex, actor },
  );
  return { nextTask: nextRaw ? nextRaw.toObject() : null, routeBlocked, closureBlockers };
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
    await releaseOtherLocksOfWorker(userTelegramId, claimed._id);
    await markSessionInProgress(claimed.orderingSessionId, { by: String(userTelegramId) });
    return { task: claimed.toObject() };
  }

  if (task.status !== 'locked') throw Object.assign(new Error('Task unavailable'), { code: 'picking_claim_unavailable' });

  const lockedAgo = Date.now() - new Date(task.lockedAt).getTime();
  if (lockedAgo < FORCE_CLAIM_AFTER_MS) {
    const tooSoonErr = Object.assign(new Error(`Too soon: locked ${Math.round(lockedAgo / 1000)}s ago`), { code: 'picking_claim_too_soon', lockedAgo });
    throw tooSoonErr;
  }

  // Pin lockedBy + lockedAt to the doc we evaluated the 3-min guard against.
  // Without this the update matches on `status:'locked'` alone, so:
  //   - two workers can both pass the guard and both findOneAndUpdate → the
  //     second silently re-steals, yet BOTH clients receive a task they think
  //     they own (double picking); and
  //   - a worker who legitimately (re)claimed the task 1s ago can be stolen
  //     from by someone whose in-memory copy still shows the old, stale lock.
  // If anything changed since we read, the filter matches nothing → the caller
  // gets picking_claim_unavailable and re-syncs from the live queue.
  const claimed = await PickingTask.findOneAndUpdate(
    { _id: task._id, status: 'locked', lockedBy: task.lockedBy, lockedAt: task.lockedAt },
    { $set: { status: 'locked', lockedBy: userTelegramId, lockedAt: new Date() } },
    { new: true },
  );
  if (!claimed) throw Object.assign(new Error('Task unavailable'), { code: 'picking_claim_unavailable' });
  await releaseOtherLocksOfWorker(userTelegramId, claimed._id);
  await markSessionInProgress(claimed.orderingSessionId, { by: String(userTelegramId) });
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
    { deliveryGroupId: groupId, orderingSessionId: sessionId, status: { $in: ['pending', 'locked'] } },
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
 * Recover from a crash where an out-of-stock task was marked `completed` (phase 1)
 * but its product was never archived (phase 2). Re-runs archiveProduct for each
 * affected product.
 *
 * Fired fire-and-forget on every next-task poll, so it is serialised per group
 * (skip-if-busy) and processes products sequentially with retries — see impl.
 */
async function archiveOrphanedOutOfStockProducts(deliveryGroupId, orderingSessionId) {
  const groupId = String(deliveryGroupId || '');
  const sessionId = String(orderingSessionId || '');
  if (!groupId || !sessionId) return { fixedCount: 0 };

  // waitMs: 0 → if a sweep for this group is already running, skip immediately
  // instead of queueing. Concurrent sweeps each spawn archiveProduct
  // transactions that all shift the same orderNumber space (shiftDown) and
  // deadlock with "Write conflict ... yielding is disabled".
  try {
    return await withLock(
      `picking:orphan-archive:${groupId}:${sessionId}`,
      () => archiveOrphanedOutOfStockProductsImpl(groupId, sessionId),
      { ttlMs: 120_000, waitMs: 0 },
    );
  } catch (err) {
    if (err && (err.code === 'lock_busy' || err.errorCode === 'lock_busy')) return { fixedCount: 0 };
    throw err;
  }
}

async function archiveOrphanedOutOfStockProductsImpl(groupId, sessionId) {
  // Recovery is BOTH cause-scoped and session-scoped. An OOS intent from a
  // previous week is historical data; it must never re-archive stock during the
  // new session. Restore consumes the same canonical signal via archiveReconciled.
  const completedTasks = await PickingTask.find(
    buildUnreconciledOosTaskFilter({
      deliveryGroupId: groupId,
      orderingSessionId: sessionId,
    }),
    'productId',
  ).sort({ updatedAt: -1 }).limit(200).lean();

  if (!completedTasks.length) return { fixedCount: 0 };

  const productIds = [...new Set(completedTasks.map((t) => String(t.productId)))];
  let fixedCount   = 0;

  // Sequential (NOT Promise.all): each archiveProduct runs shiftDown over the
  // same orderNumber range, so parallel calls write-conflict. Each is retried on
  // transient transaction errors.
  for (const pid of productIds) {
    try {
      const product = await Product.findById(pid);
      if (!product) continue;

      // If phase 2 actually committed but the signal-consumption write came from
      // an older build (or a process died around that boundary), the product is
      // already globally archived. There is nothing left to archive; consume the
      // canonical recovery signal so it does not remain an eternal false orphan.
      if (product.status === 'archived') {
        const reconciled = await PickingTask.updateMany(
          buildUnreconciledOosTaskFilter({
            productId: product._id,
            deliveryGroupId: groupId,
            orderingSessionId: sessionId,
          }),
          { $set: { archiveReconciled: true } },
        );
        if ((reconciled.modifiedCount || 0) > 0) fixedCount += 1;
        continue;
      }

      const activeTask = await PickingTask.findOne({ productId: product._id, status: { $in: ['pending', 'locked'] } }).lean();
      if (activeTask) continue;
      // Re-read at archive time: a concurrent product restore-from-archive may have
      // consumed the OOS signal (archiveReconciled=true) AFTER this sweep's initial
      // find() snapshot. Without re-checking, a sweep that is still grinding through
      // a large backlog could re-archive a product that was just restored. Restore
      // must win, so skip if no unreconciled OOS task remains for this product.
      const orphanTask = await PickingTask.findOne(
        buildUnreconciledOosTaskFilter({
          productId: product._id,
          deliveryGroupId: groupId,
          orderingSessionId: sessionId,
        }),
        '_id',
      ).lean();
      if (!orphanTask) continue;
      // archiveProduct retries transient tx errors internally; the per-group
      // lock + sequential loop already prevent concurrent shiftDown conflicts.
      await archiveProduct(product, { notifyBuyers: false, bot: null, reason: 'system_archive' });
      fixedCount += 1;
    } catch (err) {
      console.warn(`[pickingService] orphan archive failed for ${pid}:`, err.message);
    }
  }

  return { fixedCount };
}

module.exports = {
  LOCK_TIMEOUT_MS,
  FORCE_CLAIM_AFTER_MS,
  markOrderItemsPacked,
  findAndLockNext,
  releaseWorkerAndStaleLocks,
  releaseOtherLocksOfWorker,
  releasePickingTask,
  markSessionInProgress,
  completePickingTask,
  outOfStockPickingTask,
  forceClaimPickingTask,
  reconcileActiveTasksForSession,
  archiveOrphanedOutOfStockProducts,
  runTransactionWithRetry,
  withPickingFinalizeLock,
  runOperationWithRetry,
};
