'use strict';

/**
 * V35 §5 — LIVE behavioural test of the delivery-group schedule-edit guard.
 *
 * The V35 unit tests only grep `routes/deliveryGroups.js` for strings. This script
 * proves the real behaviour: it drives PATCH /api/delivery-groups/:id through the
 * real Express app against the TEST cluster and checks the 6 acceptance cases from
 * V35-SESSION-STATUS-TEST-INSTRUCTIONS.md §5.
 *
 * Safety:
 *   - refuses to run on any Mongo host outside the TEST cluster (liveE2EDbGuard);
 *   - dry-run by default, writes only with --execute;
 *   - creates ONLY synthetic docs marked __V35_GUARD__<runId> and deletes them all
 *     at the end (groups, admin user, sessions, orders, tasks, counters);
 *   - own JWT secret, no Redis, so the live cache/locks are untouched.
 *
 * Run:
 *   npm run test:v35:guard:preflight
 *   npm run test:v35:guard
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { assertEnvUriAllowed, assertConnectedHostAllowed } = require('../utils/liveE2EDbGuard');

// Env: the npm scripts preload ../dev-use-test-db.js. Standalone runs may pass
// --env=<file>; we never silently fall back to the repo-root (PROD) .env.
const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const envArg = argv.find((a) => a.startsWith('--env='));
if (envArg && !process.env.TEST_ENV_LOADED) {
  const envPath = path.resolve(process.cwd(), envArg.slice('--env='.length));
  const parsed = require('dotenv').parse(fs.readFileSync(envPath));
  for (const [k, v] of Object.entries(parsed)) process.env[k] = v;
}
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI не заданий (запускай через npm run test:v35:guard[:preflight]).');
  process.exit(2);
}
try {
  assertEnvUriAllowed(process.env.MONGODB_URI);
} catch (err) {
  console.error(`⛔ ${err.message}`);
  process.exit(3);
}

// Process isolation BEFORE any app module is required.
delete process.env.REDIS_URL;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'production';

const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const User = require('../models/User');
const Counter = require('../models/Counter');
const { signSession } = require('../utils/jwt');
const {
  getWarsawNow,
  getOpenDateWarsaw,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
  isOrderingOpen,
} = require('../utils/orderingSchedule');

const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const MARKER = `__V35_GUARD__${RUN_ID}`;
const ADMIN_TELEGRAM_ID = `v35guard-${RUN_ID}`;

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const created = { groupIds: [], userIds: [] };
const assertions = [];
let baseUrl = '';
let localServer = null;
let syntheticOrderNumber = 940_000_000 + Math.floor(Math.random() * 1_000_000);

function check(ok, label, detail = '') {
  assertions.push({ ok: !!ok, label, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}

function splitWeekMinute(total) {
  const n = ((total % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
  const day = Math.floor(n / DAY_MINUTES);
  const dm = n % DAY_MINUTES;
  return { day, hour: Math.floor(dm / 60), minute: dm % 60 };
}

/**
 * Three schedules sharing ONE weekly start boundary (⇒ one openDate/session
 * identity) plus a delivery day valid for all of them:
 *   closedA — window ended 60 min ago (the group's starting state)
 *   closedB — window ended 30 min ago (a legal timing edit, still closed)
 *   openNow — window still open (must be refused after a completed cycle)
 */
function buildGuardSchedules(nowDate = new Date()) {
  const now = getWarsawNow(nowDate);
  const q = Math.floor((now.dayOfWeek * DAY_MINUTES + now.hour * 60 + now.minute) / 15) * 15;
  const start = splitWeekMinute(q - 120);
  const mk = (endMinuteOffset) => {
    const end = splitWeekMinute(q + endMinuteOffset);
    return normalizeOrderingSchedule({
      startDay: start.day, startHour: start.hour, startMinute: start.minute,
      endDay: end.day, endHour: end.hour, endMinute: end.minute,
    });
  };
  const closedA = mk(-60);
  const closedB = mk(-30);
  const openNow = mk(+60);
  const deliveryDay = splitWeekMinute(q + 60).day;

  for (const [name, schedule] of [['closedA', closedA], ['closedB', closedB], ['openNow', openNow]]) {
    validateOrderingScheduleDeliveryDay(schedule, deliveryDay);
    const open = isOrderingOpen(schedule, nowDate).isOpen;
    if (name === 'openNow' ? !open : open) {
      throw new Error(`buildGuardSchedules: ${name} має бути ${name === 'openNow' ? 'відкритим' : 'закритим'} зараз`);
    }
  }
  return { closedA, closedB, openNow, deliveryDay };
}

function shiftScheduleDays(schedule, delta) {
  const shift = (d) => ((Number(d) + delta) % 7 + 7) % 7;
  return normalizeOrderingSchedule({
    ...schedule,
    startDay: shift(schedule.startDay),
    endDay: shift(schedule.endDay),
  });
}

async function api(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signSession(ADMIN_TELEGRAM_ID)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

async function makeGroup(name, schedule, deliveryDay) {
  const group = await DeliveryGroup.create({
    name: `${MARKER}-${name}`,
    dayOfWeek: deliveryDay,
    orderingSchedule: schedule,
  });
  created.groupIds.push(String(group._id));
  return group;
}

async function makeSession(group, schedule, pickingStatus, openDate = null) {
  return OrderingSession.create({
    groupId: String(group._id),
    openDate: openDate || getOpenDateWarsaw(schedule),
    pickingStatus,
  });
}

async function makeOrder(group, session, status) {
  return Order.create({
    buyerTelegramId: `${MARKER}-buyer-${crypto.randomBytes(2).toString('hex')}`,
    orderingSessionId: String(session._id),
    orderNumber: ++syntheticOrderNumber,
    status,
    totalPrice: 0,
    buyerSnapshot: { shopName: `${MARKER}-shop`, deliveryGroupId: String(group._id) },
    items: [{ productId: new mongoose.Types.ObjectId(), name: `${MARKER}-item`, price: 1, quantity: 1 }],
    history: [{ action: 'v35_guard_fixture' }],
  });
}

async function makeTask(group, session, status) {
  return PickingTask.create({
    productId: new mongoose.Types.ObjectId(),
    deliveryGroupId: String(group._id),
    orderingSessionId: String(session._id),
    blockId: 1,
    positionIndex: 1,
    status,
    completionReason: status === 'completed' ? 'packed' : null,
    items: [],
  });
}

// AppError serialises as { error: <code>, message: <resolved uk text> } — the
// human-readable reason lives in `message`, not in `error`.
const reasonOf = (res) => String(res.data?.message || res.data?.error || '');

const patch = (group, schedule, deliveryDay) => api('PATCH', `/api/delivery-groups/${group._id}`, {
  name: group.name,
  dayOfWeek: deliveryDay,
  orderingSchedule: schedule,
});

// ── scenarios ───────────────────────────────────────────────────────────────
async function scenarioTerminalHistoryAllows(S) {
  console.log('\n1) completed-сесія з історією НЕ блокує зміну розкладу');
  const group = await makeGroup('terminal-history', S.closedA, S.deliveryDay);
  const session = await makeSession(group, S.closedA, 'completed');
  await makeOrder(group, session, 'fulfilled');
  await makeTask(group, session, 'completed');

  const res = await patch(group, S.closedB, S.deliveryDay);
  check(res.status === 200, 'PATCH проходить попри 1 fulfilled Order + 1 completed Task',
    `status=${res.status} error=${res.data?.error || ''}`);

  const fresh = await DeliveryGroup.findById(group._id).lean();
  check(Number(fresh.orderingSchedule?.endMinute) === Number(S.closedB.endMinute)
    && Number(fresh.orderingSchedule?.endHour) === Number(S.closedB.endHour),
  'новий розклад справді збережено');

  const after = await OrderingSession.findById(session._id).lean();
  check(!(after.events || []).some((e) => e.type === 'rescheduled'),
    'completed-сесія НЕ отримала фальшивий event `rescheduled` (V35 #4)');
}

async function scenarioActiveOrderBlocks(S) {
  console.log('\n2) активне замовлення (new) блокує');
  const group = await makeGroup('active-order', S.closedA, S.deliveryDay);
  const session = await makeSession(group, S.closedA, 'pending');
  await makeOrder(group, session, 'new');

  const res = await patch(group, S.closedB, S.deliveryDay);
  check(res.status === 409, 'PATCH → 409', `status=${res.status}`);
  check(reasonOf(res).includes('активні замовлення'), 'причина — активні замовлення',
    reasonOf(res).slice(0, 120));
}

async function scenarioPendingTaskBlocks(S) {
  console.log('\n3) незавершена задача збирання (pending) блокує');
  const group = await makeGroup('pending-task', S.closedA, S.deliveryDay);
  const session = await makeSession(group, S.closedA, 'pending');
  await makeTask(group, session, 'pending');

  const res = await patch(group, S.closedB, S.deliveryDay);
  check(res.status === 409, 'PATCH → 409', `status=${res.status}`);
  check(reasonOf(res).includes('незавершені задачі'), 'причина — незавершені задачі',
    reasonOf(res).slice(0, 120));
}

async function scenarioLivePickingBlocks(S) {
  console.log('\n4) confirmed/in_progress сесія блокує навіть без замовлень і задач');
  const group = await makeGroup('live-picking', S.closedA, S.deliveryDay);
  await makeSession(group, S.closedA, 'confirmed');

  const res = await patch(group, S.closedB, S.deliveryDay);
  check(res.status === 409, 'PATCH → 409', `status=${res.status}`);
  check(reasonOf(res).includes('підтверджене чи триває'), 'причина — живий цикл збирання',
    reasonOf(res).slice(0, 120));
}

async function scenarioUsedTargetBlocks(S) {
  console.log('\n5) safety: новий розклад потрапляє в уже використану сесію');
  const group = await makeGroup('used-target', S.closedA, S.deliveryDay);
  await makeSession(group, S.closedA, 'pending'); // current: порожня, нічого живого

  const shifted = shiftScheduleDays(S.closedB, -1);
  const shiftedDeliveryDay = ((S.deliveryDay - 1) % 7 + 7) % 7;
  let targetOpenDate;
  try {
    validateOrderingScheduleDeliveryDay(shifted, shiftedDeliveryDay);
    targetOpenDate = getOpenDateWarsaw(shifted);
  } catch (err) {
    check(false, 'фікстура зсунутого розкладу валідна', err.message);
    return;
  }
  const target = await makeSession(group, shifted, 'pending', targetOpenDate);
  await makeOrder(group, target, 'fulfilled'); // терміналка, але сесія вже ВИКОРИСТАНА

  const res = await patch(group, shifted, shiftedDeliveryDay);
  check(res.status === 409, 'PATCH → 409', `status=${res.status}`);
  check(reasonOf(res).includes('використану сесію'), 'причина — used target session',
    reasonOf(res).slice(0, 140));
}

async function scenarioReopenCompletedBlocks(S) {
  console.log('\n6) safety: новий розклад повторно відкрив би завершений цикл');
  const group = await makeGroup('reopen-completed', S.closedA, S.deliveryDay);
  const session = await makeSession(group, S.closedA, 'completed');
  await makeTask(group, session, 'completed');

  const res = await patch(group, S.openNow, S.deliveryDay);
  check(res.status === 409, 'PATCH → 409', `status=${res.status}`);
  check(reasonOf(res).includes('повторно відкрив'), 'причина — reopen completed cycle',
    reasonOf(res).slice(0, 140));
}

// ── runner ──────────────────────────────────────────────────────────────────
async function startLocalApp() {
  const app = require('../app');
  localServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${localServer.address().port}`;
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json()).catch(() => null);
  check(health?.status === 'ok', 'ефемерний Express піднято', baseUrl);
}

async function cleanup() {
  if (!created.groupIds.length && !created.userIds.length) return;
  const gids = created.groupIds;
  const sessions = await OrderingSession.find({ groupId: { $in: gids } }, '_id').lean();
  const sids = sessions.map((s) => String(s._id));
  const res = await Promise.all([
    Order.deleteMany({ orderingSessionId: { $in: sids } }),
    PickingTask.deleteMany({ deliveryGroupId: { $in: gids } }),
    OrderingSession.deleteMany({ groupId: { $in: gids } }),
    DeliveryGroup.deleteMany({ _id: { $in: gids } }),
    User.deleteMany({ _id: { $in: created.userIds } }),
    Counter.deleteMany({ name: { $in: gids.map((g) => `session-seq:${g}`) } }),
  ]);
  console.log(`\n🧹 прибрано: orders=${res[0].deletedCount} tasks=${res[1].deletedCount} sessions=${res[2].deletedCount} groups=${res[3].deletedCount} users=${res[4].deletedCount} counters=${res[5].deletedCount}`);

  const leftovers = await Promise.all([
    DeliveryGroup.countDocuments({ name: { $regex: `^${MARKER}` } }),
    Order.countDocuments({ buyerTelegramId: { $regex: `^${MARKER}` } }),
    User.countDocuments({ telegramId: ADMIN_TELEGRAM_ID }),
  ]);
  check(leftovers.every((n) => n === 0), 'жодного залишку фікстур у базі', `group=${leftovers[0]} order=${leftovers[1]} user=${leftovers[2]}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  console.log(`\n🧪 V35 schedule-guard live test · db=${mongoose.connection.name} · host=${mongoose.connection.host}`);
  console.log(`   run=${RUN_ID} · режим: ${EXECUTE ? '⚠️  ЗАПИС (--execute)' : 'PREFLIGHT (нічого не пишу)'}`);

  const schedules = buildGuardSchedules();
  console.log(`   фікстури: start=${schedules.closedA.startDay}/${schedules.closedA.startHour}:${String(schedules.closedA.startMinute).padStart(2, '0')} · openDate=${getOpenDateWarsaw(schedules.closedA)} · deliveryDay=${schedules.deliveryDay}`);
  check(true, 'фікстури розкладів валідні (closedA/closedB закриті, openNow відкритий)');

  if (!EXECUTE) {
    console.log('\nPREFLIGHT ok — запусти з --execute, щоб реально прогнати 6 сценаріїв.');
    return;
  }

  const admin = await User.create({
    telegramId: ADMIN_TELEGRAM_ID,
    firstName: 'V35',
    lastName: 'Guard',
    role: 'admin',
  });
  created.userIds.push(String(admin._id));

  await startLocalApp();
  try {
    await scenarioTerminalHistoryAllows(schedules);
    await scenarioActiveOrderBlocks(schedules);
    await scenarioPendingTaskBlocks(schedules);
    await scenarioLivePickingBlocks(schedules);
    await scenarioUsedTargetBlocks(schedules);
    await scenarioReopenCompletedBlocks(schedules);
  } finally {
    await cleanup();
  }
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.stack || err.message}`);
    assertions.push({ ok: false, label: 'runner', detail: err.message });
  })
  .finally(async () => {
    if (localServer) await new Promise((r) => localServer.close(r));
    await mongoose.disconnect().catch(() => {});
    const failed = assertions.filter((a) => !a.ok);
    console.log(`\n${failed.length ? '❌' : '✅'} перевірок: ${assertions.length - failed.length}/${assertions.length}`);
    for (const f of failed) console.log(`   ❌ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(failed.length ? 1 : 0);
  });
