'use strict';

/**
 * diagnoseSessionState — STRICT READ-ONLY session/picking diagnostic.
 *
 * No mongoose models are imported. The script uses the native MongoDB driver,
 * secondaryPreferred reads, and hard-patches collection write methods to throw.
 * It never calls getOrCreateSessionId, so inspection cannot materialise a session.
 *
 * Usage:
 *   node scripts/diagnoseSessionState.js --all
 *   node scripts/diagnoseSessionState.js --group="Понеділок Достава"
 *   node scripts/diagnoseSessionState.js --session=64f...
 *   node scripts/diagnoseSessionState.js --all --env=../arturmarkarag-db-user.env
 */

const path = require('path');
const dotenv = require('dotenv');
const { MongoClient, Collection, ObjectId } = require('mongodb');
const { isOrderingOpen, getOpenDateWarsaw } = require('../utils/orderingSchedule');

const argv = process.argv.slice(2);
const getArg = (name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};
const ALL = argv.includes('--all');
const GROUP_ARG = getArg('group');
const SESSION_ARG = getArg('session');
const ENV_ARG = getArg('env');
const envPath = ENV_ARG
  ? path.resolve(process.cwd(), ENV_ARG)
  : path.resolve(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace',
  'findOneAndDelete', 'bulkWrite', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'drop', 'rename',
];
for (const method of WRITE_METHODS) {
  if (typeof Collection.prototype[method] !== 'function') continue;
  Collection.prototype[method] = function readonlyWriteGuard() {
    throw new Error(`[READ_ONLY_GUARD] prohibited Mongo write: ${method}`);
  };
}

const ACTIVE_ORDER = new Set(['new', 'in_progress']);
const TERMINAL_ORDER = new Set(['fulfilled', 'confirmed', 'cancelled']);
const ACTIVE_TASK = new Set(['pending', 'locked']);
const ACTIVE_PICKING = new Set(['confirmed', 'in_progress']);

function id(v) { return v == null ? '' : String(v); }
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
}
function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) || 'null';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
function addDays(openDate, days) {
  const [y, m, d] = String(openDate || '').split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + days));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}
function printCounts(label, counts) {
  const text = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(' · ');
  console.log(`  ${label}: ${text || '0'}`);
}

async function diagnoseSession(db, group, session) {
  const sid = id(session._id);
  const [orders, tasks] = await Promise.all([
    db.collection('orders').find({ orderingSessionId: sid }).project({
      status: 1, buyerTelegramId: 1, buyerSnapshot: 1, items: 1,
    }).toArray(),
    db.collection('pickingtasks').find({ orderingSessionId: sid }).project({
      status: 1, productId: 1, completionReason: 1, archiveReconciled: 1,
      lockedBy: 1, lockedAt: 1, items: 1,
    }).toArray(),
  ]);

  let packed = 0; let cancelled = 0; let skipped = 0; let voided = 0; let open = 0;
  for (const order of orders) {
    if (order.status === 'expired') continue;
    for (const item of order.items || []) {
      if (item.voided) voided += 1;
      else if (item.cancelled) cancelled += 1;
      else if (item.skipped) skipped += 1;
      else if (item.packed) packed += 1;
      else open += 1;
    }
  }

  const operationalOrders = orders.filter((o) => o.status !== 'expired');
  const completedOrders = operationalOrders.filter((o) => TERMINAL_ORDER.has(o.status)).length;
  const activeOrders = operationalOrders.filter((o) => ACTIVE_ORDER.has(o.status)).length;
  const activeTasks = tasks.filter((t) => ACTIVE_TASK.has(t.status));
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  const archiveTasks = completedTasks.filter((t) => ['out_of_stock', 'system_archive'].includes(t.completionReason));
  const archivedDone = archiveTasks.filter((t) => t.completionReason === 'system_archive' || t.archiveReconciled === true);
  const unreconciledOos = archiveTasks.filter((t) => t.completionReason === 'out_of_stock' && t.archiveReconciled !== true);

  const archiveProductIds = [...new Set(archiveTasks.map((t) => id(t.productId)).filter(Boolean))];
  const archiveProducts = archiveProductIds.length
    ? await db.collection('products').find({ _id: { $in: archiveProductIds.filter(ObjectId.isValid).map((x) => new ObjectId(x)) } })
      .project({ status: 1, name: 1, archivedAt: 1 }).toArray()
    : [];
  const productMap = new Map(archiveProducts.map((p) => [id(p._id), p]));
  const archiveStateProblems = archiveTasks.filter((t) => {
    const p = productMap.get(id(t.productId));
    return t.completionReason === 'out_of_stock' && (t.archiveReconciled !== true || p?.status !== 'archived');
  });

  const blockers = [];
  if (activeOrders) blockers.push(`active_orders=${activeOrders}`);
  if (activeTasks.length) blockers.push(`active_tasks=${activeTasks.length}`);
  if (open) blockers.push(`open_items=${open}`);
  if (unreconciledOos.length) blockers.push(`unreconciled_oos=${unreconciledOos.length}`);
  if (archiveStateProblems.length) blockers.push(`archive_state_problems=${archiveStateProblems.length}`);
  if (session.pickingStatus === 'completed' && completedTasks.length !== tasks.length) {
    blockers.push(`completed_session_but_tasks=${completedTasks.length}/${tasks.length}`);
  }

  console.log(`\n${'═'.repeat(88)}`);
  console.log(`${group.name || group._id} · session=${sid} · openDate=${session.openDate || '—'} · seq=${session.seq ?? 'NULL'}`);
  console.log(`${'═'.repeat(88)}`);
  console.log(`  pickingStatus: ${session.pickingStatus || 'pending'}`);
  console.log(`  confirmed: ${fmtDate(session.pickingConfirmedAt)} · started: ${fmtDate(session.pickingStartedAt)} · completed: ${fmtDate(session.pickingCompletedAt)}`);
  printCounts('Orders', countBy(orders, (o) => o.status));
  printCounts('PickingTasks', countBy(tasks, (t) => `${t.status}/${t.completionReason || 'none'}`));
  console.log(`  OrderItems: packed=${packed} · cancelled=${cancelled} · skipped=${skipped} · voided=${voided} · OPEN=${open}`);
  console.log(`  UI summary: опрацьовано товарів ${completedTasks.length}/${tasks.length} · завершено замовлень ${completedOrders}/${operationalOrders.length} · архівовано ${archivedDone.length}/${archiveTasks.length}`);
  console.log(`  live blockers: orders=${activeOrders} · tasks=${activeTasks.length} · pickingLifecycle=${ACTIVE_PICKING.has(session.pickingStatus) ? 'ACTIVE' : 'no'}`);
  console.log(`  archive reconciliation: required=${archiveTasks.length} · reconciled=${archivedDone.length} · issues=${archiveStateProblems.length}`);
  console.log(`  VERDICT: ${blockers.length ? `❌ ${blockers.join(' · ')}` : '✅ CLEAN / terminal'}`);

  return { blockers, activeOrders, activeTasks: activeTasks.length };
}

let client = null;

async function main() {
  if (!process.env.MONGODB_URI) throw new Error(`MONGODB_URI не знайдено. env=${envPath}`);
  client = new MongoClient(process.env.MONGODB_URI, {
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 20_000,
  });
  await client.connect();
  const db = client.db();
  const hello = await db.command({ ping: 1 });
  if (hello.ok !== 1) throw new Error('Mongo ping failed');

  console.log('\n🔒 diagnoseSessionState — STRICT READ-ONLY');
  console.log(`   db=${db.databaseName} · env=${envPath}`);
  console.log('   native driver · secondaryPreferred · write methods hard-blocked');

  const groups = await db.collection('deliverygroups').find({}).project({ name: 1, dayOfWeek: 1, orderingSchedule: 1 }).toArray();
  let selectedGroups = groups;
  if (GROUP_ARG) {
    selectedGroups = groups.filter((g) => id(g._id) === GROUP_ARG || String(g.name || '').toLowerCase().includes(GROUP_ARG.toLowerCase()));
  }
  if (!ALL && !GROUP_ARG && !SESSION_ARG) {
    throw new Error('Вкажіть --all, --group="Назва" або --session=<id>');
  }

  if (SESSION_ARG) {
    if (!ObjectId.isValid(SESSION_ARG)) throw new Error('--session має бути ObjectId');
    const session = await db.collection('orderingsessions').findOne({ _id: new ObjectId(SESSION_ARG) });
    if (!session) throw new Error('OrderingSession не знайдено');
    const group = groups.find((g) => id(g._id) === id(session.groupId)) || { _id: session.groupId, name: `group ${session.groupId}` };
    await diagnoseSession(db, group, session);
    return;
  }

  for (const group of selectedGroups) {
    const gid = id(group._id);
    const currentOpenDate = getOpenDateWarsaw(group.orderingSchedule);
    const session = await db.collection('orderingsessions').findOne({ groupId: gid, openDate: currentOpenDate });
    const window = isOrderingOpen(group.orderingSchedule);
    console.log(`\nGROUP ${group.name || gid}: window=${window.isOpen ? 'OPEN' : 'CLOSED'} · currentOpenDate=${currentOpenDate}`);
    if (!session) {
      console.log('  current OrderingSession: немає (read-only script нічого не materialize-ить)');
      continue;
    }
    await diagnoseSession(db, group, session);

    // Show exactly whether the V35 schedule-edit guard would still block this
    // group because of live work in current + materialised next session.
    const nextOpenDate = addDays(currentOpenDate, 7);
    const next = await db.collection('orderingsessions').findOne({ groupId: gid, openDate: nextOpenDate }, { projection: { _id: 1, pickingStatus: 1 } });
    const protectedIds = [id(session._id), next ? id(next._id) : null].filter(Boolean);
    const [liveOrderCount, liveTaskCount, liveLifecycleCount] = await Promise.all([
      db.collection('orders').countDocuments({ orderingSessionId: { $in: protectedIds }, status: { $in: [...ACTIVE_ORDER] } }),
      db.collection('pickingtasks').countDocuments({ orderingSessionId: { $in: protectedIds }, status: { $in: [...ACTIVE_TASK] } }),
      db.collection('orderingsessions').countDocuments({ _id: { $in: protectedIds.filter(ObjectId.isValid).map((x) => new ObjectId(x)) }, pickingStatus: { $in: [...ACTIVE_PICKING] } }),
    ]);
    console.log(`  V35 schedule-edit live guard: orders=${liveOrderCount} · tasks=${liveTaskCount} · lifecycle=${liveLifecycleCount} → ${liveOrderCount || liveTaskCount || liveLifecycleCount ? 'BLOCK' : 'ALLOW (subject to target-session/reopen safety checks)'}`);
  }
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exitCode = 1;
  })
  // Without closing the driver the process keeps the Atlas sockets (and the
  // terminal) open forever — the operator sees the full report and then waits
  // on a prompt that never returns.
  .finally(async () => { if (client) await client.close().catch(() => {}); });
