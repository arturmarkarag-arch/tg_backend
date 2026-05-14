'use strict';

/**
 * Production Data Integrity Audit
 *
 * Run this as a separate health-check / cron job — NOT in CI/CD alongside unit tests.
 * Reads only production data; makes no writes.
 *
 * Run: node server/test-audit.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Product     = require('./models/Product');
const Block       = require('./models/Block');
const Order       = require('./models/Order');
const PickingTask = require('./models/PickingTask');
const DeliveryGroup = require('./models/DeliveryGroup');
const User        = require('./models/User');

let passed = 0;
let failed = 0;
const warnings = [];
const failures = [];

function ok(msg)   { process.stdout.write(`  ✓ ${msg}\n`); passed++; }
function fail(msg) { process.stdout.write(`  ✗ ${msg}\n`); failed++; failures.push(msg); }
function warn(msg) { process.stdout.write(`  ⚠ ${msg}\n`); warnings.push(msg); }
function info(msg) { process.stdout.write(`  ℹ ${msg}\n`); }
function section(name) {
  console.log(`\n${'─'.repeat(60)}\n  ${name}\n${'─'.repeat(60)}`);
}

async function audit() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Production Data Integrity Audit                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected ✓\n');

  // ── 1. Block integrity ────────────────────────────────────────────────────
  section('1. Block Integrity');

  // 1a. Product in more than one block
  const multiBlock = await Block.aggregate([
    { $unwind: '$productIds' },
    { $group: { _id: '$productIds', count: { $sum: 1 }, blocks: { $push: '$blockId' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (multiBlock.length === 0) ok('No product appears in multiple blocks');
  else {
    fail(`${multiBlock.length} product(s) appear in multiple blocks`);
    multiBlock.slice(0, 5).forEach((x) => warn(`  product ${x._id} in blocks ${x.blocks.join(', ')}`));
  }

  // 1b. Active products not placed in any block
  const placedIds = new Set(
    (await Block.find({}, 'productIds').lean()).flatMap((b) => b.productIds.map(String))
  );
  const activeProducts = await Product.find({ status: 'active' }, '_id name orderNumber').lean();
  const unplaced = activeProducts.filter((p) => !placedIds.has(String(p._id)));
  if (unplaced.length === 0) ok('All active products are placed in a block');
  else {
    warn(`${unplaced.length} active product(s) not placed in any block:`);
    unplaced.slice(0, 5).forEach((p) => info(`  #${p.orderNumber} ${p.name}`));
  }

  // ── 2. PickingTask integrity ──────────────────────────────────────────────
  section('2. PickingTask Integrity');

  // 2a. Active tasks referencing archived products
  const archivedIds = new Set(
    (await Product.find({ status: 'archived' }, '_id').lean()).map((p) => String(p._id))
  );
  const activeTasks = await PickingTask.find({ status: { $in: ['pending', 'locked'] } }, 'productId deliveryGroupId').lean();
  const tasksOnArchived = activeTasks.filter((t) => archivedIds.has(String(t.productId)));
  if (tasksOnArchived.length === 0) ok('No active picking tasks reference archived products');
  else fail(`${tasksOnArchived.length} active task(s) reference archived products`);

  // 2b. Active tasks referencing products not in any block
  const tasksOutsideBlocks = activeTasks.filter((t) => !placedIds.has(String(t.productId)));
  if (tasksOutsideBlocks.length === 0) ok('All active tasks have their product in a block');
  else warn(`${tasksOutsideBlocks.length} active task(s) whose product is not in any block`);

  // 2c. Stale locks (> 15 min)
  const staleLockedAt = new Date(Date.now() - 15 * 60 * 1000);
  const staleTasks = await PickingTask.find({ status: 'locked', lockedAt: { $lt: staleLockedAt } }).lean();
  if (staleTasks.length === 0) ok('No stale locked tasks (> 15 min)');
  else {
    warn(`${staleTasks.length} stale locked task(s) — will be auto-released on next /next-task call`);
    staleTasks.slice(0, 3).forEach((t) => {
      const mins = Math.round((Date.now() - new Date(t.lockedAt)) / 60000);
      info(`  lockedBy=${t.lockedBy} ${mins} min ago`);
    });
  }

  // 2d. Duplicate orderId within one task
  const dupItems = await PickingTask.aggregate([
    { $match: { status: { $in: ['pending', 'locked', 'completed'] } } },
    { $project: { unique: { $size: { $setUnion: ['$items.orderId', []] } }, total: { $size: '$items' } } },
    { $match: { $expr: { $lt: ['$unique', '$total'] } } },
  ]);
  if (dupItems.length === 0) ok('No picking tasks with duplicate orderId items');
  else fail(`${dupItems.length} task(s) with duplicate orderId items`);

  // ── 3. Order integrity ────────────────────────────────────────────────────
  section('3. Order Integrity');

  // 3a. Ghost orders: all items done but status still active
  const ghostOrders = await Order.find({
    status: { $in: ['new', 'in_progress'] },
    'items.0': { $exists: true },
    $nor: [{ items: { $elemMatch: { packed: false, cancelled: false } } }],
  }, '_id status').lean();
  if (ghostOrders.length === 0) ok('No ghost orders (all items done but status still active)');
  else fail(`${ghostOrders.length} ghost order(s) with stale active status`);

  // 3b. Duplicate productId within one order
  const dupOrderItems = await Order.aggregate([
    { $match: { status: { $in: ['new', 'in_progress'] } } },
    { $project: { unique: { $size: { $setUnion: ['$items.productId', []] } }, total: { $size: '$items' } } },
    { $match: { $expr: { $lt: ['$unique', '$total'] } } },
  ]);
  if (dupOrderItems.length === 0) ok('No active orders with duplicate productId items');
  else fail(`${dupOrderItems.length} active order(s) with duplicate productId items`);

  // ── 4. Schema validation ──────────────────────────────────────────────────
  section('4. Schema Validation');

  // 4a. DeliveryGroup dayOfWeek range
  const badGroups = await DeliveryGroup.find({ $or: [{ dayOfWeek: { $lt: 0 } }, { dayOfWeek: { $gt: 6 } }] }).lean();
  if (badGroups.length === 0) ok('All delivery groups have valid dayOfWeek (0–6)');
  else fail(`${badGroups.length} delivery group(s) with invalid dayOfWeek`);

  // 4b. Users with role=seller but no shop assignment
  const danglingUsers = await User.find(
    { role: 'seller', shopId: null, $or: [{ deliveryGroupId: '' }, { deliveryGroupId: null }] },
    'telegramId firstName'
  ).lean();
  if (danglingUsers.length === 0) ok('All sellers have a shop assignment');
  else info(`${danglingUsers.length} seller(s) without shop/deliveryGroup (may be registration-in-progress)`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${String(passed).padStart(2)} passed  ${String(failed).padStart(2)} failed  ${String(warnings.length).padStart(2)} warnings           ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (failures.length) {
    console.log('\nFAILURES (require immediate attention):');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  if (warnings.length) {
    console.log('\nWARNINGS (non-blocking, investigate when possible):');
    warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

audit().catch((err) => { console.error('\n[FATAL]', err); process.exit(1); });
