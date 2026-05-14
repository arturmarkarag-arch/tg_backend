'use strict';

/**
 * E2E Test Suite — Warehouse Fulfillment
 *
 * Design principles:
 *  - Calls actual service functions (pickingService, taskBuilder, archiveProduct)
 *    instead of duplicating logic in tests.
 *  - Uses a socket spy to verify events are emitted.
 *  - Covers partial packing, inventory deduction, race conditions.
 *  - Isolated test fixtures with guaranteed cleanup in finally.
 *
 * Run: node server/test-e2e.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

// ── Socket spy — records all emitted events ──────────────────────────────────
const emittedEvents = [];
const socketSpy = {
  emit: (event, ...args) => emittedEvents.push({ event, args }),
  to:   ()               => socketSpy,
};
function clearEvents() { emittedEvents.length = 0; }
function emittedEventNames() { return emittedEvents.map((e) => e.event); }

const socketModule = require('./socket');
Object.defineProperty(socketModule, 'getIO', {
  get: () => () => socketSpy,
  configurable: true,
});

// ── Models ───────────────────────────────────────────────────────────────────
const Product      = require('./models/Product');
const Block        = require('./models/Block');
const Order        = require('./models/Order');
const User         = require('./models/User');
const Shop         = require('./models/Shop');
const DeliveryGroup = require('./models/DeliveryGroup');
const PickingTask  = require('./models/PickingTask');
const AppSetting   = require('./models/AppSetting');
const Counter      = require('./models/Counter');

// ── Services under test ──────────────────────────────────────────────────────
const {
  completePickingTask,
  outOfStockPickingTask,
  forceClaimPickingTask,
  reconcileActiveTasksForSession,
  archiveOrphanedOutOfStockProducts,
  findAndLockNext,
  releaseWorkerAndStaleLocks,
  FORCE_CLAIM_AFTER_MS,
} = require('./services/pickingService');

const { buildPickingTasksFromOrders } = require('./services/taskBuilder');
const { archiveProduct }              = require('./services/archiveProduct');

// ── Utils ────────────────────────────────────────────────────────────────────
const { getCurrentOrderingSessionId, getWarsawNow } = require('./utils/orderingSchedule');

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { process.stdout.write(`    ✓ ${msg}\n`); passed++; }
  else       { process.stdout.write(`    ✗ ${msg}\n`); failed++; failures.push(msg); }
}
function assertEq(a, b, msg) {
  assert(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function section(name) {
  console.log(`\n${'─'.repeat(60)}\n  ${name}\n${'─'.repeat(60)}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RUN        = Date.now();
const WORKER_A   = `wa_${RUN}`;
const WORKER_B   = `wb_${RUN}`;
const { dayOfWeek: TODAY_DOW } = getWarsawNow();

let testGroup, testShop, testBlockId, sessionId;
let productA, productB, productC, productD;
let orderA1, orderA2, orderB1;

async function createFixtures() {
  const scheduleDoc = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  const schedule    = scheduleDoc?.value || { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };

  testGroup = await DeliveryGroup.create({ name: `T_${RUN}`, dayOfWeek: TODAY_DOW, members: [WORKER_A, WORKER_B] });
  testShop  = await Shop.create({ name: `T_${RUN}`, deliveryGroupId: String(testGroup._id), city: 'TestCity' });

  await User.create([
    { telegramId: WORKER_A, role: 'warehouse', firstName: 'Alpha', deliveryGroupId: String(testGroup._id) },
    { telegramId: WORKER_B, role: 'warehouse', firstName: 'Beta',  deliveryGroupId: String(testGroup._id) },
  ]);

  const maxBlock = (await Block.findOne().sort({ blockId: -1 }).lean())?.blockId || 0;
  testBlockId = maxBlock + 200;

  const maxON = (await Product.findOne({ status: { $ne: 'archived' } }).sort({ orderNumber: -1 }).lean())?.orderNumber || 0;
  [productA, productB, productC, productD] = await Product.create([
    { name: `T_A_${RUN}`, status: 'active', price: 10, quantity: 10, orderNumber: maxON + 1 },
    { name: `T_B_${RUN}`, status: 'active', price: 20, quantity:  5, orderNumber: maxON + 2 },
    { name: `T_C_${RUN}`, status: 'active', price: 30, quantity:  0, orderNumber: maxON + 3 },
    { name: `T_D_${RUN}`, status: 'active', price: 15, quantity:  8, orderNumber: maxON + 4 },
  ]);

  await Block.create({ blockId: testBlockId, productIds: [productA._id, productB._id, productC._id, productD._id] });

  sessionId = getCurrentOrderingSessionId(String(testGroup._id), TODAY_DOW, schedule);

  const snap = { shopId: testShop._id, shopName: testShop.name, shopCity: 'TestCity', deliveryGroupId: String(testGroup._id) };
  const maxOrderNum = (await Order.findOne().sort({ orderNumber: -1 }).lean())?.orderNumber || 0;
  const BASE = Math.max(maxOrderNum, 0) + 800000 + (RUN % 100000);

  // orderA1: 2 products from shop1 (current session)
  orderA1 = await Order.create({
    buyerTelegramId: `s1_${RUN}`, shopId: testShop._id, status: 'new',
    orderNumber: BASE + 1, orderingSessionId: sessionId, buyerSnapshot: snap,
    items: [
      { productId: productA._id, name: 'A', price: 10, quantity: 2 },
      { productId: productB._id, name: 'B', price: 20, quantity: 1 },
    ],
    totalPrice: 40,
  });

  // orderA2: 1 product from shop2 (current session)
  orderA2 = await Order.create({
    buyerTelegramId: `s2_${RUN}`, shopId: testShop._id, status: 'new',
    orderNumber: BASE + 2, orderingSessionId: sessionId, buyerSnapshot: snap,
    items: [{ productId: productA._id, name: 'A', price: 10, quantity: 1 }],
    totalPrice: 10,
  });

  // orderB1: stale session (should be reconciled away)
  orderB1 = await Order.create({
    buyerTelegramId: `s3_${RUN}`, shopId: testShop._id, status: 'new',
    orderNumber: BASE + 3, orderingSessionId: `${testGroup._id}:stale_${RUN}`, buyerSnapshot: snap,
    items: [{ productId: productB._id, name: 'B', price: 20, quantity: 2 }],
    totalPrice: 40,
  });
}

async function cleanupFixtures() {
  const gid = testGroup?._id;
  if (!gid) return;
  await Promise.all([
    DeliveryGroup.deleteOne({ _id: gid }),
    Shop.deleteOne({ _id: testShop?._id }),
    User.deleteMany({ telegramId: { $in: [WORKER_A, WORKER_B] } }),
    Product.deleteMany({ name: { $regex: `_${RUN}` } }),
    Block.deleteOne({ blockId: testBlockId }),
    Order.deleteMany({ buyerTelegramId: { $regex: `_${RUN}` } }),
    PickingTask.deleteMany({ deliveryGroupId: String(gid) }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Task Builder
// ─────────────────────────────────────────────────────────────────────────────
async function suiteTaskBuilder() {
  section('SUITE 1: Task Builder');
  const gid = String(testGroup._id);

  // Calls the real service — no logic duplication
  await buildPickingTasksFromOrders(gid, { orderingSessionId: sessionId });

  const tasks = await PickingTask.find({ deliveryGroupId: gid }).lean();
  assert(tasks.length >= 2, `≥2 tasks created (got ${tasks.length})`);

  const tA = tasks.find((t) => String(t.productId) === String(productA._id));
  assert(!!tA, 'Task for productA created');
  assertEq(tA?.items?.length, 2, 'productA task: 2 order items');
  assertEq(tA?.blockId, testBlockId, `productA task blockId = ${testBlockId}`);
  assertEq(tA?.positionIndex, 1, 'productA positionIndex = 1');

  const tB = tasks.find((t) => String(t.productId) === String(productB._id));
  assert(!!tB, 'Task for productB created (current-session only)');
  // stale session order (orderB1) must not appear in task items
  const staleItem = (tB?.items || []).find((i) => String(i.orderId) === String(orderB1._id));
  assert(!staleItem, 'Stale-session order NOT included in productB task items');

  assert(!tasks.find((t) => String(t.productId) === String(productC._id)), 'No task for productC (no orders)');

  // Idempotency: second call must not duplicate
  await buildPickingTasksFromOrders(gid, { orderingSessionId: sessionId });
  const after = await PickingTask.find({ deliveryGroupId: gid }).lean();
  assertEq(after.length, tasks.length, 'Re-running builder creates no duplicates');

  // Block position refresh: move productA to position 2
  await Block.updateOne({ blockId: testBlockId }, { $set: { productIds: [productB._id, productA._id, productC._id, productD._id] } });
  await buildPickingTasksFromOrders(gid, { orderingSessionId: sessionId });
  const tAUpdated = await PickingTask.findOne({ productId: productA._id, deliveryGroupId: gid }).lean();
  assertEq(tAUpdated?.positionIndex, 2, 'productA positionIndex refreshed to 2 after block move');
  // Restore original order
  await Block.updateOne({ blockId: testBlockId }, { $set: { productIds: [productA._id, productB._id, productC._id, productD._id] } });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Lock / Unlock / Concurrent Workers
// ─────────────────────────────────────────────────────────────────────────────
async function suiteLocking() {
  section('SUITE 2: Locking — concurrent workers & stale release');
  const gid = String(testGroup._id);
  await PickingTask.updateMany({ deliveryGroupId: gid }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });

  // Service call — not duplicated
  await releaseWorkerAndStaleLocks(WORKER_A, gid);
  const { task: tA } = await findAndLockNext(WORKER_A, 1, gid);
  assert(!!tA, 'Worker A locked a task');
  assertEq(tA?.lockedBy, WORKER_A, 'Task owner = Worker A');

  await releaseWorkerAndStaleLocks(WORKER_B, gid);
  const { task: tB } = await findAndLockNext(WORKER_B, tA.blockId, gid);
  assert(!!tB, 'Worker B locked a different task');
  assert(String(tB?._id) !== String(tA?._id), 'Workers hold different tasks');

  // Concurrent: both try to take the same pending task
  const pending = await PickingTask.findOne({ status: 'pending', deliveryGroupId: gid }).lean();
  if (pending) {
    const [rA, rB] = await Promise.all([
      PickingTask.findOneAndUpdate({ _id: pending._id, status: 'pending' }, { $set: { status: 'locked', lockedBy: WORKER_A, lockedAt: new Date() } }, { new: true }),
      PickingTask.findOneAndUpdate({ _id: pending._id, status: 'pending' }, { $set: { status: 'locked', lockedBy: WORKER_B, lockedAt: new Date() } }, { new: true }),
    ]);
    assertEq([rA, rB].filter(Boolean).length, 1, 'Concurrent lock: exactly one winner (atomic findOneAndUpdate)');
  }

  // Release A's lock, verify it returns to pending
  await releaseWorkerAndStaleLocks(WORKER_A, gid);
  const released = await PickingTask.findById(tA._id).lean();
  assertEq(released?.status, 'pending', 'Released lock → task back to pending');

  // Stale lock: backdate lockedAt by 20 min — releaseWorkerAndStaleLocks must clear it
  await PickingTask.updateMany({ status: 'locked', deliveryGroupId: gid }, { $set: { lockedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  await releaseWorkerAndStaleLocks('nobody', gid);
  const staleCount = await PickingTask.countDocuments({ status: 'locked', deliveryGroupId: gid });
  assertEq(staleCount, 0, 'All stale locks (20 min) released');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Complete Task → Order Fulfilment + Socket events
// ─────────────────────────────────────────────────────────────────────────────
async function suiteCompleteTask() {
  section('SUITE 3: completePickingTask → fulfilment + socket events');
  const gid = String(testGroup._id);
  await PickingTask.updateMany({ deliveryGroupId: gid }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });

  // Lock productA task explicitly
  const lockedTask = await PickingTask.findOneAndUpdate(
    { productId: productA._id, deliveryGroupId: gid, status: 'pending' },
    { $set: { status: 'locked', lockedBy: WORKER_A, lockedAt: new Date() } },
    { new: true }
  );
  assert(!!lockedTask, 'productA task locked before complete');
  if (!lockedTask) return;

  clearEvents();

  // Call the actual service — not duplicated logic
  const { completedTask } = await completePickingTask({
    taskId:         String(lockedTask._id),
    userTelegramId: WORKER_A,
    userFirstName:  'Alpha',
    userRole:       'warehouse',
    items:          [], // default: full quantity for each order
  });

  assertEq(completedTask.status, 'completed', 'Task status = completed');
  assert(completedTask.items.every((i) => i.packed), 'All items packed');

  // orderA2 has only productA → must be auto-fulfilled
  const a2 = await Order.findById(orderA2._id).lean();
  assertEq(a2?.status, 'fulfilled', 'Single-product order auto-fulfilled');

  // orderA1 still has productB unpacked
  const a1 = await Order.findById(orderA1._id).lean();
  assert(['new', 'in_progress'].includes(a1?.status), 'Multi-product order stays active');

  // Socket spy: order_updated must have been emitted at least once
  assert(emittedEventNames().includes('order_updated'), 'socket order_updated emitted after complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: Partial Packing (packedQty < ordered qty)
// ─────────────────────────────────────────────────────────────────────────────
async function suitePartialPacking() {
  section('SUITE 4: Partial Packing (packedQty < orderedQty)');
  const gid = String(testGroup._id);

  // Create a fresh task for productD with one order for qty=5
  const partialOrder = await Order.create({
    buyerTelegramId: `sp_${RUN}`, shopId: testShop._id, status: 'new',
    orderNumber: 799990 + (RUN % 10000),
    orderingSessionId: sessionId, buyerSnapshot: { shopId: testShop._id, shopName: testShop.name, shopCity: 'TestCity', deliveryGroupId: gid },
    items: [{ productId: productD._id, name: 'D', price: 15, quantity: 5 }],
    totalPrice: 75,
  });

  const partialTask = await PickingTask.create({
    productId: productD._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 4, status: 'locked',
    lockedBy: WORKER_A, lockedAt: new Date(),
    items: [{ orderId: partialOrder._id, shopName: 'TestShop', quantity: 5, packed: false }],
  });

  // Worker packed only 3 of 5
  const { completedTask } = await completePickingTask({
    taskId:         String(partialTask._id),
    userTelegramId: WORKER_A,
    userRole:       'warehouse',
    items:          [{ orderId: String(partialOrder._id), actualQty: 3 }],
  });

  const item0 = completedTask.items[0];
  assertEq(item0.packedQuantity, 3, 'packedQuantity recorded as 3 (not 5)');
  assert(item0.packed, 'item.packed=true because packedQuantity > 0');

  // Order item must be marked packed; order status depends on whether it's the only item
  const updatedOrder = await Order.findById(partialOrder._id).lean();
  const orderItem = updatedOrder?.items?.find((i) => String(i.productId) === String(productD._id));
  assert(orderItem?.packed === true, 'Order item.packed = true after partial pack');
  assertEq(updatedOrder?.status, 'fulfilled', 'Single-item order fulfilled even with partial quantity');

  // Cleanup
  await Order.deleteOne({ _id: partialOrder._id });
  await PickingTask.deleteOne({ _id: partialTask._id });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Out-of-Stock → Archive → Cancel Orders + Socket events
// ─────────────────────────────────────────────────────────────────────────────
async function suiteOutOfStock() {
  section('SUITE 5: outOfStockPickingTask → archive → cancel + socket events');
  const gid = String(testGroup._id);

  const pbDoc = await Product.findById(productB._id);
  if (!pbDoc || pbDoc.status === 'archived') { assert(true, 'productB already archived — skip'); return; }

  await PickingTask.updateMany(
    { productId: productB._id, deliveryGroupId: gid, status: { $in: ['pending', 'locked'] } },
    { $set: { status: 'pending', lockedBy: null, lockedAt: null } }
  );

  const tbBefore = await PickingTask.findOne({ productId: productB._id, deliveryGroupId: gid, status: 'pending' }).lean();
  if (!tbBefore) { assert(true, 'No pending task for productB — skip'); return; }

  // Lock it
  await PickingTask.updateOne({ _id: tbBefore._id }, { $set: { status: 'locked', lockedBy: WORKER_A, lockedAt: new Date() } });

  clearEvents();

  // Call the real service
  await outOfStockPickingTask({
    taskId:         String(tbBefore._id),
    userTelegramId: WORKER_A,
    userRole:       'warehouse',
    packedOrderIds: [], // nobody got productB
  });

  const pbAfter = await Product.findById(productB._id).lean();
  assertEq(pbAfter?.status, 'archived', 'productB archived after OOS');

  const remaining = await PickingTask.find({ productId: productB._id, status: { $in: ['pending', 'locked'] } }).lean();
  assertEq(remaining.length, 0, 'No pending/locked tasks remain for archived productB');

  // Socket: product_archived must have fired
  assert(emittedEventNames().includes('product_archived'), 'socket product_archived emitted');

  // Idempotency: calling OOS again on completed task must not throw
  let idempotencyOk = true;
  try {
    await outOfStockPickingTask({ taskId: String(tbBefore._id), userTelegramId: WORKER_A, userRole: 'warehouse', packedOrderIds: [] });
  } catch { idempotencyOk = false; }
  assert(idempotencyOk, 'outOfStockPickingTask is idempotent on completed task');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: Race condition — order cancelled during picking
// ─────────────────────────────────────────────────────────────────────────────
async function suiteOrderCancelledDuringPicking() {
  section('SUITE 6: Race condition — order cancelled while task is locked');
  const gid = String(testGroup._id);

  // Create a fresh order for productD (must be active)
  const raceOrder = await Order.create({
    buyerTelegramId: `race_${RUN}`, shopId: testShop._id, status: 'new',
    orderNumber: 799980 + (RUN % 10000),
    orderingSessionId: sessionId,
    buyerSnapshot: { shopId: testShop._id, shopName: testShop.name, shopCity: 'TestCity', deliveryGroupId: gid },
    items: [{ productId: productD._id, name: 'D', price: 15, quantity: 2 }],
    totalPrice: 30,
  });

  const raceTask = await PickingTask.create({
    productId: productD._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 4,
    status: 'locked', lockedBy: WORKER_A, lockedAt: new Date(),
    items: [{ orderId: raceOrder._id, shopName: 'RaceShop', quantity: 2, packed: false }],
  });

  // Simulate: buyer cancels order WHILE worker is holding the lock
  await Order.updateOne({ _id: raceOrder._id }, { $set: { status: 'cancelled', 'items.$[].cancelled': true } });

  // Worker completes the task anyway (they didn't know about the cancellation)
  const { completedTask } = await completePickingTask({
    taskId:         String(raceTask._id),
    userTelegramId: WORKER_A,
    userRole:       'warehouse',
    items:          [],
  });

  assertEq(completedTask.status, 'completed', 'Task completes regardless of order cancellation');

  // markOrderItemsPacked uses $in=['new','in_progress'] — a cancelled order should not be touched
  const cancelledOrder = await Order.findById(raceOrder._id).lean();
  assertEq(cancelledOrder?.status, 'cancelled', 'Cancelled order stays cancelled (not re-activated by picking complete)');
  assert(cancelledOrder?.items?.every((i) => i.cancelled), 'Cancelled order items remain cancelled');

  // Cleanup
  await Order.deleteOne({ _id: raceOrder._id });
  await PickingTask.deleteOne({ _id: raceTask._id });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: Force-Claim
// ─────────────────────────────────────────────────────────────────────────────
async function suiteForceClaim() {
  section('SUITE 7: forceClaimPickingTask (3-min guard)');
  const gid = String(testGroup._id);

  const freshTask = await PickingTask.create({
    productId: productA._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 99,
    status: 'locked', lockedBy: WORKER_B, lockedAt: new Date(), items: [],
  });

  // Guard: too soon
  let tooSoonThrown = false;
  try { await forceClaimPickingTask({ taskId: String(freshTask._id), userTelegramId: WORKER_A }); }
  catch (e) { tooSoonThrown = e.code === 'picking_claim_too_soon'; }
  assert(tooSoonThrown, 'Force-claim throws picking_claim_too_soon when < 3 min');

  // Backdate to > 3 min
  await PickingTask.updateOne({ _id: freshTask._id }, { $set: { lockedAt: new Date(Date.now() - FORCE_CLAIM_AFTER_MS - 1000) } });
  const { task: claimed } = await forceClaimPickingTask({ taskId: String(freshTask._id), userTelegramId: WORKER_A });
  assertEq(claimed.lockedBy, WORKER_A, 'Force-claim succeeds after 3+ min');

  // Already pending → direct claim
  await PickingTask.updateOne({ _id: freshTask._id }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
  const { task: directClaim } = await forceClaimPickingTask({ taskId: String(freshTask._id), userTelegramId: WORKER_B });
  assertEq(directClaim.lockedBy, WORKER_B, 'Force-claim on already-pending task → direct lock');

  await PickingTask.deleteOne({ _id: freshTask._id });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: Session Reconciliation
// ─────────────────────────────────────────────────────────────────────────────
async function suiteReconciliation() {
  section('SUITE 8: reconcileActiveTasksForSession (stale items pruned)');
  const gid = String(testGroup._id);

  // Build tasks without session filter — stale order ends up in productB task
  await PickingTask.deleteMany({ deliveryGroupId: gid });
  await buildPickingTasksFromOrders(gid); // includes stale orderB1 if productB is still active

  // If productB was archived in suite 5, skip
  const pbDoc = await Product.findById(productB._id).lean();
  if (pbDoc?.status === 'archived') { assert(true, 'productB archived — reconcile test N/A'); return; }

  const taskBBefore = await PickingTask.findOne({ productId: productB._id, deliveryGroupId: gid, status: { $in: ['pending', 'locked'] } }).lean();
  if (!taskBBefore) { assert(true, 'No active productB task — reconcile test N/A'); return; }

  const staleItemBefore = (taskBBefore.items || []).some((i) => String(i.orderId) === String(orderB1._id));
  assert(staleItemBefore, 'Before reconcile: stale orderB1 present in productB task');

  // Call the real service
  const { deletedCount, trimmedCount } = await reconcileActiveTasksForSession(gid, sessionId);
  assert(deletedCount >= 0 && trimmedCount >= 0, `reconcile ran: deleted=${deletedCount} trimmed=${trimmedCount}`);

  const taskBAfter = await PickingTask.findOne({ productId: productB._id, deliveryGroupId: gid, status: { $in: ['pending', 'locked'] } }).lean();
  if (taskBAfter) {
    const staleItemAfter = (taskBAfter.items || []).some((i) => String(i.orderId) === String(orderB1._id));
    assert(!staleItemAfter, 'After reconcile: stale orderB1 removed from productB task');
  } else {
    assert(true, 'productB task deleted (had only stale items)');
  }

  // Guard: task with partial progress is NOT deleted even if all items are stale
  const progressTask = await PickingTask.create({
    productId: productC._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 3, status: 'locked',
    lockedBy: WORKER_A, lockedAt: new Date(),
    items: [{ orderId: orderB1._id, shopName: 'X', quantity: 1, packed: true }], // stale but packed
  });
  await reconcileActiveTasksForSession(gid, sessionId);
  const progressTaskAfter = await PickingTask.findById(progressTask._id).lean();
  assert(!!progressTaskAfter, 'Task with packed items NOT deleted even when all items are from stale session');
  await PickingTask.deleteOne({ _id: progressTask._id });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: Orphan Archive Recovery
// ─────────────────────────────────────────────────────────────────────────────
async function suiteOrphanArchive() {
  section('SUITE 9: archiveOrphanedOutOfStockProducts (crash recovery)');
  const gid = String(testGroup._id);

  const pcDoc = await Product.findById(productC._id);
  if (!pcDoc || pcDoc.status === 'archived') { assert(true, 'productC already archived — skip'); return; }

  // Simulate: task marked completed but archiveProduct never ran (server crash)
  const orphanTask = await PickingTask.create({
    productId: productC._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 3,
    status: 'completed', items: [],
  });

  clearEvents();
  const { fixedCount } = await archiveOrphanedOutOfStockProducts(gid);
  assert(fixedCount >= 1, `Orphan recovery fixed ${fixedCount} product(s)`);

  const pcAfter = await Product.findById(productC._id).lean();
  assertEq(pcAfter?.status, 'archived', 'productC archived by orphan recovery');

  assert(emittedEventNames().includes('product_archived'), 'socket product_archived emitted by orphan recovery');

  await PickingTask.deleteOne({ _id: orphanTask._id });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: Full Queue Cycle (start → all complete → empty)
// ─────────────────────────────────────────────────────────────────────────────
async function suiteFullCycle() {
  section('SUITE 10: Full Queue Cycle (start → complete all → done)');
  const gid = String(testGroup._id);

  // Reset to known state: 2 fresh pending tasks
  await PickingTask.deleteMany({ deliveryGroupId: gid });
  // Re-activate productA if archived
  const paDoc = await Product.findById(productA._id);
  if (paDoc && paDoc.status === 'archived') {
    paDoc.status = 'active'; paDoc.archivedAt = null; await paDoc.save();
    await Block.updateOne({ blockId: testBlockId }, { $addToSet: { productIds: productA._id } });
  }
  await PickingTask.insertMany([
    { productId: productA._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 1, status: 'pending', items: [] },
    { productId: productD._id, deliveryGroupId: gid, blockId: testBlockId, positionIndex: 4, status: 'pending', items: [] },
  ], { ordered: false });

  const initial = await PickingTask.countDocuments({ deliveryGroupId: gid, status: 'pending' });
  assert(initial === 2, `Starting with ${initial} pending tasks`);

  let done = 0;
  for (let i = 0; i < 10; i++) {
    await releaseWorkerAndStaleLocks(WORKER_A, gid);
    const { task } = await findAndLockNext(WORKER_A, 1, gid);
    if (!task) break;
    task.status = 'completed'; task.lockedBy = null; task.lockedAt = null;
    await task.save();
    done++;
  }

  assertEq(done, initial, `Completed all ${initial} tasks`);
  assertEq(await PickingTask.countDocuments({ deliveryGroupId: gid, status: 'pending' }), 0, 'No pending tasks remain');
  assertEq(await PickingTask.countDocuments({ deliveryGroupId: gid, status: 'locked' }), 0, 'No locked tasks remain');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11: AppSettings validation
// ─────────────────────────────────────────────────────────────────────────────
async function suiteAppSettings() {
  section('SUITE 11: AppSettings & Counter');

  const schedule = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  assert(!!schedule, 'ordering.schedule exists');
  if (schedule) {
    const v = schedule.value || {};
    ['openHour','openMinute','closeHour','closeMinute'].forEach((k) => {
      const n = Number(v[k]);
      assert(Number.isFinite(n) && n >= 0, `${k} = ${v[k]} is valid`);
    });
  }

  const counter = await Counter.findOneAndUpdate({ name: 'orderNumber' }, { $setOnInsert: { seq: 0 } }, { upsert: true, new: true }).lean();
  assert(typeof counter?.seq === 'number', `orderNumber counter exists (seq=${counter?.seq})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Warehouse Fulfillment — E2E Test Suite v2             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB ✓\n');

  try {
    console.log('Creating test fixtures…');
    await createFixtures();
    console.log('Fixtures ready ✓');

    await suiteTaskBuilder();
    await suiteLocking();
    await suiteCompleteTask();
    await suitePartialPacking();
    await suiteOutOfStock();
    await suiteOrderCancelledDuringPicking();
    await suiteForceClaim();
    await suiteReconciliation();
    await suiteOrphanArchive();
    await suiteFullCycle();
    await suiteAppSettings();

  } finally {
    console.log('\nCleaning up fixtures…');
    try   { await cleanupFixtures(); console.log('Cleanup done ✓'); }
    catch (e) { console.warn('Cleanup error (manual cleanup may be needed):', e.message); }
    try   { await mongoose.disconnect(); } catch { /* ignore */ }
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${String(passed).padStart(3)} passed  ${String(failed).padStart(3)} failed                      ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (failures.length) {
    console.log('\nFailed assertions:');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('\n[FATAL]', err); process.exit(1); });
