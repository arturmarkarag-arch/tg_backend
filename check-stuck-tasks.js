'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const PickingTask   = require('./models/PickingTask');
const Product       = require('./models/Product');
const Order         = require('./models/Order');
const Block         = require('./models/Block');
const DeliveryGroup = require('./models/DeliveryGroup');
const AppSetting    = require('./models/AppSetting');

const { getCurrentOrderingSessionId, getWarsawNow } = require('./utils/orderingSchedule');

function section(t) { console.log(`\n${'─'.repeat(64)}\n  ${t}\n${'─'.repeat(64)}`); }
function row(label, val, note = '') {
  console.log(`  ${label.padEnd(42)} ${String(val).padStart(6)}  ${note}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  // ── pre-load lookup maps ────────────────────────────────────────────────
  const schedDoc   = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  const sched      = schedDoc?.value || { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };
  const { dayOfWeek: todayDOW } = getWarsawNow();

  const allGroups  = await DeliveryGroup.find({}, '_id dayOfWeek').lean();
  const sessionMap = new Map(allGroups.map(g => [
    String(g._id),
    getCurrentOrderingSessionId(String(g._id), g.dayOfWeek, sched),
  ]));

  const archivedIds = new Set(
    (await Product.find({ status: 'archived' }, '_id').lean()).map(p => String(p._id))
  );
  const pendingProductIds = new Set(
    (await Product.find({ status: 'pending' }, '_id').lean()).map(p => String(p._id))
  );

  const placedIds = new Set(
    (await Block.find({}, 'productIds').lean()).flatMap(b => b.productIds.map(String))
  );

  const activeTasks = await PickingTask.find(
    { status: { $in: ['pending', 'locked'] } },
    'productId deliveryGroupId blockId positionIndex status lockedBy lockedAt items'
  ).lean();

  // ── Category buckets ────────────────────────────────────────────────────
  const cats = {
    archivedProduct:  [],   // product is archived → will never be picked
    pendingProduct:   [],   // product is pending (not active) → skipped by builder
    notInBlock:       [],   // product not in any block → findAndLockNext skips it
    allOrdersDone:    [],   // every order item is packed/cancelled → useless task
    allOrdersGone:    [],   // every orderId references a non-existent or cancelled order
    staleSession:     [],   // task items belong to a previous ordering session
    staleLock:        [],   // locked > 15 min (will auto-release, but shows backlog)
    healthy:          [],   // none of the above
  };

  const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  const now = Date.now();

  for (const task of activeTasks) {
    const pid  = String(task.productId);
    const gid  = String(task.deliveryGroupId || '');
    const currentSession = sessionMap.get(gid) || null;

    // 1. archived product
    if (archivedIds.has(pid)) { cats.archivedProduct.push(task); continue; }

    // 2. product still pending (not yet active)
    if (pendingProductIds.has(pid)) { cats.pendingProduct.push(task); continue; }

    // 3. product not in any block
    if (!placedIds.has(pid)) { cats.notInBlock.push(task); continue; }

    // 4. stale lock
    const isStale = task.status === 'locked' && task.lockedAt &&
      (now - new Date(task.lockedAt).getTime()) > LOCK_TIMEOUT_MS;
    if (isStale) { cats.staleLock.push(task); }  // don't continue — could also be stale session

    // 5. check order items
    const orderIds = (task.items || []).map(i => String(i.orderId));
    if (orderIds.length === 0) {
      // no items → nothing to pack → useless
      cats.allOrdersDone.push(task);
      continue;
    }

    const orderDocs = await Order.find(
      { _id: { $in: orderIds } },
      '_id status orderingSessionId items'
    ).lean();

    const orderMap = new Map(orderDocs.map(o => [String(o._id), o]));

    // 6. all orders gone (deleted or never existed)
    const missing = orderIds.filter(id => !orderMap.has(id));
    if (missing.length === orderIds.length) {
      cats.allOrdersGone.push({ ...task, _missing: missing });
      continue;
    }

    // 7. all orders packed/cancelled/fulfilled/expired
    const activeOrders = orderDocs.filter(o => ['new', 'in_progress'].includes(o.status));
    if (activeOrders.length === 0) {
      cats.allOrdersDone.push(task);
      continue;
    }

    // 8. stale session — every item's order belongs to old session
    if (currentSession) {
      const currentSessionOrders = orderDocs.filter(o => String(o.orderingSessionId) === currentSession);
      if (currentSessionOrders.length === 0) {
        cats.staleSession.push({ ...task, _taskSession: orderDocs[0]?.orderingSessionId, _currentSession: currentSession });
        continue;
      }
    }

    if (!isStale) cats.healthy.push(task);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  section('STUCK TASKS ANALYSIS');
  row('Total active tasks (pending+locked)',  activeTasks.length);
  console.log();
  row('🔴 Product archived (unreachable)',    cats.archivedProduct.length,  '→ should be completed/deleted');
  row('🟠 Product still pending (not active)',cats.pendingProduct.length,   '→ waiting for warehouse to activate');
  row('🟠 Product not in any block',          cats.notInBlock.length,       '→ builder skips, picker never sees');
  row('🟡 All orders done/cancelled',         cats.allOrdersDone.length,    '→ task is pointless, safe to delete');
  row('🟡 All orders missing/deleted',        cats.allOrdersGone.length,    '→ orphan task, safe to delete');
  row('🟡 Stale session (old window)',         cats.staleSession.length,     '→ reconcile will remove on next start-session');
  row('🔵 Stale lock (>15 min, auto-release)',cats.staleLock.length,        '→ released on next /next-task call');
  row('✅ Healthy tasks',                      cats.healthy.length,          '→ will be processed normally');

  // ── Detail: archived product tasks ──────────────────────────────────────
  if (cats.archivedProduct.length) {
    section('🔴 Tasks with ARCHIVED product (will NEVER be processed)');
    for (const t of cats.archivedProduct) {
      const p = await Product.findById(t.productId, 'name brand model orderNumber archivedAt').lean();
      console.log(`  taskId=${t._id}  status=${t.status}`);
      console.log(`    product: "${p?.name || p?.brand || p?.model || '?'}"  #${p?.orderNumber}  archivedAt=${p?.archivedAt?.toISOString().slice(0,10)}`);
      console.log(`    orders:  ${(t.items||[]).map(i=>i.orderId).join(', ')}`);
    }
  }

  // ── Detail: product not in block ─────────────────────────────────────────
  if (cats.notInBlock.length) {
    section('🟠 Tasks whose product is NOT IN ANY BLOCK');
    for (const t of cats.notInBlock) {
      const p = await Product.findById(t.productId, 'name brand model orderNumber status').lean();
      console.log(`  taskId=${t._id}  status=${t.status}`);
      console.log(`    product: "${p?.name || p?.brand || p?.model || '?'}"  #${p?.orderNumber}  status=${p?.status}`);
    }
  }

  // ── Detail: all orders done ───────────────────────────────────────────────
  if (cats.allOrdersDone.length) {
    section('🟡 Tasks where ALL orders are already fulfilled/cancelled');
    for (const t of cats.allOrdersDone) {
      const p = await Product.findById(t.productId, 'name brand model orderNumber').lean();
      console.log(`  taskId=${t._id}  status=${t.status}  product="${p?.name || p?.brand || '?'}"  #${p?.orderNumber}`);
      for (const item of (t.items || [])) {
        const o = await Order.findById(item.orderId, 'status orderingSessionId').lean();
        console.log(`    order=${item.orderId}  status=${o?.status || 'NOT FOUND'}  packed=${item.packed}`);
      }
    }
  }

  // ── Detail: stale session tasks ───────────────────────────────────────────
  if (cats.staleSession.length) {
    section('🟡 Tasks from STALE SESSION (reconcile will clean on next start-session)');
    for (const t of cats.staleSession) {
      const p = await Product.findById(t.productId, 'name brand model orderNumber').lean();
      console.log(`  taskId=${t._id}  status=${t.status}  product="${p?.name || p?.brand || '?'}"`);
      console.log(`    task session:    ${t._taskSession}`);
      console.log(`    current session: ${t._currentSession}`);
    }
  }

  // ── Detail: stale locks ───────────────────────────────────────────────────
  if (cats.staleLock.length) {
    section('🔵 STALE LOCKS (auto-released on next /next-task call)');
    for (const t of cats.staleLock) {
      const mins = Math.round((now - new Date(t.lockedAt).getTime()) / 60000);
      const p = await Product.findById(t.productId, 'name brand model orderNumber').lean();
      console.log(`  taskId=${t._id}  lockedBy=${t.lockedBy}  ${mins} min ago`);
      console.log(`    product="${p?.name || p?.brand || '?'}"  #${p?.orderNumber}`);
    }
  }

  // ── Fix suggestion ────────────────────────────────────────────────────────
  const critical = cats.archivedProduct.length;
  const cleanable = cats.allOrdersDone.length + cats.allOrdersGone.length;

  if (critical > 0 || cleanable > 0) {
    section('РЕКОМЕНДАЦІЇ');
    if (critical > 0) {
      console.log(`  ⚡ ${critical} задач з archived продуктом — треба позначити completed:`);
      console.log(`     db.pickingtasks.updateMany(`);
      console.log(`       { _id: { $in: [${cats.archivedProduct.map(t=>`ObjectId("${t._id}")`).join(', ')}] } },`);
      console.log(`       { $set: { status: "completed", lockedBy: null, lockedAt: null } }`);
      console.log(`     )`);
    }
    if (cleanable > 0) {
      const ids = [...cats.allOrdersDone, ...cats.allOrdersGone].map(t => `ObjectId("${t._id}")`);
      console.log(`\n  🧹 ${cleanable} порожніх задач — безпечно видалити:`);
      console.log(`     db.pickingtasks.deleteMany(`);
      console.log(`       { _id: { $in: [${ids.join(', ')}] } }`);
      console.log(`     )`);
    }
  } else {
    console.log('\n  ✅ Критичних застряглих задач не знайдено.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
