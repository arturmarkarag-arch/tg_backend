'use strict';

/**
 * Load & Concurrency Test
 *
 * Simulates real warehouse pressure:
 *  - N workers simultaneously locking/completing tasks
 *  - Concurrent start-session calls (idempotency under race)
 *  - Concurrent task builder calls (duplicate prevention)
 *  - Lock contention measurements
 *
 * Run: node server/test-load.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

// Mock socket
const sock = require('./socket');
Object.defineProperty(sock, 'getIO', { get: () => () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }), configurable: true });

const Product    = require('./models/Product');
const Block      = require('./models/Block');
const Order      = require('./models/Order');
const PickingTask = require('./models/PickingTask');
const DeliveryGroup = require('./models/DeliveryGroup');
const Shop       = require('./models/Shop');
const User       = require('./models/User');
const AppSetting = require('./models/AppSetting');

const { buildPickingTasksFromOrders } = require('./services/taskBuilder');
const { findAndLockNext, releaseWorkerAndStaleLocks, completePickingTask } = require('./services/pickingService');
const { getCurrentOrderingSessionId, getWarsawNow } = require('./utils/orderingSchedule');

// ── helpers ───────────────────────────────────────────────────────────────────
const RUN = Date.now();
const { dayOfWeek: TODAY_DOW } = getWarsawNow();

function ms(label, fn) {
  return async (...args) => {
    const t = Date.now();
    const r = await fn(...args);
    return { result: r, ms: Date.now() - t };
  };
}

function section(name) {
  console.log(`\n${'═'.repeat(60)}\n  ${name}\n${'═'.repeat(60)}`);
}

function row(label, value, unit = '') {
  const pad = 38;
  console.log(`  ${label.padEnd(pad)} ${String(value).padStart(8)} ${unit}`);
}

// ── Fixture setup ─────────────────────────────────────────────────────────────
let group, shop, blockId, sessionId;
const PRODUCT_COUNT = 20;  // tasks to fill
const WORKER_COUNT  = 5;   // concurrent workers
const products = [];
const orders   = [];
const workerIds = Array.from({ length: WORKER_COUNT }, (_, i) => `load_w${i}_${RUN}`);

async function setup() {
  const schedDoc = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  const sched    = schedDoc?.value || { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };

  group = await DeliveryGroup.create({ name: `L_${RUN}`, dayOfWeek: TODAY_DOW });
  shop  = await Shop.create({ name: `L_${RUN}`, deliveryGroupId: String(group._id) });

  await User.create(workerIds.map(tid => ({ telegramId: tid, role: 'warehouse', firstName: `W${tid}`, deliveryGroupId: String(group._id) })));

  const maxBlock = (await Block.findOne().sort({ blockId: -1 }).lean())?.blockId || 0;
  blockId = maxBlock + 300;

  const maxON = (await Product.findOne({ status: { $ne: 'archived' } }).sort({ orderNumber: -1 }).lean())?.orderNumber || 0;
  const created = await Product.insertMany(
    Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
      name: `LP_${RUN}_${i}`, status: 'active', price: 10, quantity: 5, orderNumber: maxON + i + 1,
    }))
  );
  products.push(...created);

  await Block.create({ blockId, productIds: products.map(p => p._id) });

  sessionId = getCurrentOrderingSessionId(String(group._id), TODAY_DOW, sched);
  const snap = { shopId: shop._id, shopName: shop.name, shopCity: 'Test', deliveryGroupId: String(group._id) };
  const maxOrderNum = (await Order.findOne().sort({ orderNumber: -1 }).lean())?.orderNumber || 0;
  const BASE = Math.max(maxOrderNum, 0) + 700000 + (RUN % 50000);

  const createdOrders = await Order.insertMany(
    products.map((p, i) => ({
      buyerTelegramId: `ls_${RUN}_${i}`,
      shopId: shop._id, status: 'new',
      orderNumber: BASE + i,
      orderingSessionId: sessionId,
      buyerSnapshot: snap,
      items: [{ productId: p._id, name: p.name, price: 10, quantity: 1 }],
      totalPrice: 10,
    }))
  );
  orders.push(...createdOrders);
}

async function cleanup() {
  const gid = group?._id;
  if (!gid) return;
  await Promise.all([
    DeliveryGroup.deleteOne({ _id: gid }),
    Shop.deleteOne({ _id: shop?._id }),
    User.deleteMany({ telegramId: { $in: workerIds } }),
    Product.deleteMany({ name: { $regex: `LP_${RUN}` } }),
    Block.deleteOne({ blockId }),
    Order.deleteMany({ buyerTelegramId: { $regex: `ls_${RUN}` } }),
    PickingTask.deleteMany({ deliveryGroupId: String(gid) }),
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1: Concurrent buildPickingTasksFromOrders (idempotency under race)
// ══════════════════════════════════════════════════════════════════════════════
async function testConcurrentBuilder() {
  section(`TEST 1: ${WORKER_COUNT} concurrent buildPickingTasksFromOrders calls`);

  const gid = String(group._id);
  await PickingTask.deleteMany({ deliveryGroupId: gid });

  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: WORKER_COUNT }, () =>
      buildPickingTasksFromOrders(gid, { orderingSessionId: sessionId })
    )
  );
  const elapsed = Date.now() - t0;

  const fulfilled = results.filter(r => r.status === 'fulfilled').length;
  const rejected  = results.filter(r => r.status === 'rejected').length;
  const taskCount = await PickingTask.countDocuments({ deliveryGroupId: gid });

  row('Concurrent calls', WORKER_COUNT);
  row('Fulfilled', fulfilled);
  row('Rejected (errors)', rejected);
  row('Tasks in DB after race', taskCount, `(expected ${PRODUCT_COUNT})`);
  row('Elapsed', elapsed, 'ms');

  const ok = taskCount === PRODUCT_COUNT;
  console.log(ok
    ? `  ✓ Exactly ${PRODUCT_COUNT} tasks — no duplicates despite race`
    : `  ✗ FAIL: expected ${PRODUCT_COUNT}, got ${taskCount} — possible duplicates!`);

  return ok;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2: Concurrent task locking (only one winner per task)
// ══════════════════════════════════════════════════════════════════════════════
async function testConcurrentLocking() {
  section(`TEST 2: ${WORKER_COUNT} workers race to lock the SAME task`);

  const gid = String(group._id);
  await PickingTask.updateMany({ deliveryGroupId: gid }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });

  // All workers try to lock from block 1 simultaneously
  const t0 = Date.now();
  const results = await Promise.all(
    workerIds.map(wid => findAndLockNext(wid, blockId, gid))
  );
  const elapsed = Date.now() - t0;

  const locked = results.filter(r => r.task !== null);
  const lockedIds = locked.map(r => String(r.task._id));
  const uniqueIds = new Set(lockedIds);

  row('Workers racing', WORKER_COUNT);
  row('Workers that got a task', locked.length);
  row('Unique task IDs locked', uniqueIds.size, `(should equal workers who got a task)`);
  row('Elapsed', elapsed, 'ms');
  row('Avg lock time per worker', Math.round(elapsed / WORKER_COUNT), 'ms');

  const noDupes = uniqueIds.size === locked.length;
  console.log(noDupes
    ? `  ✓ No two workers hold the same task — findOneAndUpdate is atomic`
    : `  ✗ FAIL: duplicate task IDs detected!`);

  return noDupes;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3: Full throughput — N workers completing all tasks concurrently
// ══════════════════════════════════════════════════════════════════════════════
async function testThroughput() {
  section(`TEST 3: ${WORKER_COUNT} workers completing ${PRODUCT_COUNT} tasks in parallel`);

  const gid = String(group._id);
  await PickingTask.updateMany({ deliveryGroupId: gid }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });

  let completedTotal = 0;
  let errors = 0;
  const latencies = [];
  const t0 = Date.now();

  // Each worker keeps picking until queue is empty
  await Promise.all(
    workerIds.map(async (wid) => {
      while (true) {
        await releaseWorkerAndStaleLocks(wid, gid);
        const { task } = await findAndLockNext(wid, blockId, gid);
        if (!task) break;

        const ts = Date.now();
        try {
          await completePickingTask({
            taskId: String(task._id),
            userTelegramId: wid,
            userRole: 'warehouse',
            items: [],
          });
          latencies.push(Date.now() - ts);
          completedTotal++;
        } catch (err) {
          // expired_lock is expected if another worker's stale-lock release freed this task
          if (err.code !== 'expired_lock') errors++;
          // Release and move on
          await PickingTask.updateOne({ _id: task._id, lockedBy: wid }, { $set: { status: 'pending', lockedBy: null, lockedAt: null } });
        }
      }
    })
  );

  const elapsed = Date.now() - t0;
  const remaining = await PickingTask.countDocuments({ deliveryGroupId: gid, status: { $in: ['pending', 'locked'] } });

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

  row('Tasks completed', completedTotal, `/ ${PRODUCT_COUNT}`);
  row('Errors (non-expiredLock)', errors);
  row('Remaining pending/locked', remaining, '(should be 0)');
  row('Total elapsed', elapsed, 'ms');
  row('Throughput', Math.round(completedTotal / (elapsed / 1000)), 'tasks/sec');
  row('Latency p50', p50, 'ms');
  row('Latency p95', p95, 'ms');
  row('Latency p99', p99, 'ms');

  const ok = remaining === 0 && errors === 0;
  console.log(ok
    ? `  ✓ All tasks completed cleanly by ${WORKER_COUNT} concurrent workers`
    : `  ✗ FAIL: remaining=${remaining} errors=${errors}`);

  return ok;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4: Concurrent complete calls on the same locked task (expired_lock guard)
// ══════════════════════════════════════════════════════════════════════════════
async function testDoubleComplete() {
  section('TEST 4: Two workers try to complete the same task (expired_lock guard)');

  const gid = String(group._id);

  // Create one fresh task, locked by worker 0
  const t = await PickingTask.create({
    productId: products[0]._id, deliveryGroupId: gid,
    blockId, positionIndex: 1, status: 'locked',
    lockedBy: workerIds[0], lockedAt: new Date(), items: [],
  });

  const [r1, r2] = await Promise.allSettled([
    completePickingTask({ taskId: String(t._id), userTelegramId: workerIds[0], userRole: 'warehouse', items: [] }),
    completePickingTask({ taskId: String(t._id), userTelegramId: workerIds[1], userRole: 'warehouse', items: [] }),
  ]);

  const ok1 = r1.status === 'fulfilled';
  const err2 = r2.status === 'rejected' && r2.reason?.code === 'expired_lock';

  row('Worker 0 (owner) completes', ok1 ? 'OK' : 'FAIL');
  row('Worker 1 (not owner) gets expired_lock', err2 ? 'OK' : `FAIL (${r2.reason?.code})`);

  const allOk = ok1 && err2;
  console.log(allOk
    ? '  ✓ Lock ownership enforced — only owner can complete'
    : '  ✗ FAIL: lock ownership not enforced!');

  await PickingTask.deleteOne({ _id: t._id });
  return allOk;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║   Load & Concurrency Test  (${WORKER_COUNT} workers / ${PRODUCT_COUNT} tasks)      ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('\nConnected ✓  Setting up fixtures…');
  await setup();
  console.log(`Fixtures: ${PRODUCT_COUNT} products, ${PRODUCT_COUNT} orders, ${WORKER_COUNT} workers ✓`);

  const results = [];
  try {
    results.push(await testConcurrentBuilder());
    results.push(await testConcurrentLocking());
    results.push(await testThroughput());
    results.push(await testDoubleComplete());
  } finally {
    console.log('\nCleaning up…');
    try { await cleanup(); console.log('Cleanup done ✓'); } catch (e) { console.warn('Cleanup error:', e.message); }
    await mongoose.disconnect();
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  Load test: ${passed}/${results.length} passed${failed ? `  ← ${failed} FAILED` : '  ✓ all green'}                   ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('\n[FATAL]', err); process.exit(1); });
