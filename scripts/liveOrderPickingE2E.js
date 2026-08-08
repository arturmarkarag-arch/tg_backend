'use strict';

/**
 * LIVE MongoDB E2E suite for the order → picking lifecycle.
 *
 * IMPORTANT:
 *   - Uses the REAL MONGODB_URI and REAL production collections/indexes/transactions.
 *   - Creates ONLY synthetic entities marked with __LIVE_E2E__<runId>.
 *   - Does NOT reuse real sellers, shops, groups or products.
 *   - Starts the real Express app on 127.0.0.1 with a throw-away JWT secret and
 *     calls the normal HTTP routes (orders, conflict resolve, start picking,
 *     claim/progress/complete/OOS/coverage repair).
 *   - REDIS_URL is intentionally disabled inside THIS process so the suite never
 *     invalidates or pollutes the production Redis/cache/locks. MongoDB unique
 *     indexes + transactions are still the real live ones under test.
 *   - The shared global orderNumber Counter is intercepted ONLY inside this test
 *     process and replaced with 9xx,xxx,xxx synthetic numbers. Otherwise a test
 *     run would leave permanent gaps in real order numbering after cleanup.
 *   - Per-test-group session counters ARE real because their keys are scoped by
 *     the synthetic group id and are deleted during cleanup.
 *
 * Safe default: without --execute this script performs preflight ONLY.
 *
 * Run:
 *   node scripts/liveOrderPickingE2E.js --execute
 *
 * Optional:
 *   --scenario=happy,conflict_move,conflict_relocate,conflict_unassign,coverage,isolation,barrier,short_pick,oos,late_order,recovery,hidden_item,group_mismatch,remove_last
 *   --keep-on-failure     Keep ONLY the failed scenario fixtures for manual inspection.
 *                         Cleanup command + run id are printed. Never enabled by default.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { assertEnvUriAllowed, assertConnectedHostAllowed, allowedSuffix } = require('../utils/liveE2EDbGuard');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = normalized.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    process.env[key] = value;
  }
  return true;
}

for (const candidate of [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, './.env'),
  path.resolve(__dirname, '../../.env'),
]) {
  if (loadEnvFile(candidate)) break;
}

const argv = process.argv.slice(2);
const execute = argv.includes('--execute');
const keepOnFailure = argv.includes('--keep-on-failure');
const scenarioArg = argv.find((a) => a.startsWith('--scenario='));
const requestedScenarios = scenarioArg
  ? new Set(scenarioArg.slice('--scenario='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null;

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI не заданий. Запусти скрипт у backend-середовищі з live env.');
  process.exit(2);
}
try {
  assertEnvUriAllowed(process.env.MONGODB_URI);
} catch (err) {
  console.error(`⛔ ${err.message}`);
  process.exit(3);
}

// Test process isolation. Never touch the live Redis/cache/lock namespace.
const hadRedis = Boolean(process.env.REDIS_URL);
delete process.env.REDIS_URL;
// The ephemeral localhost Express server uses a throw-away token key; no prod JWTs
// are accepted or emitted by this process.
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
// Keep normal production route surface; warehouse-test dev endpoints are not needed.
process.env.NODE_ENV = 'production';

const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const User = require('../models/User');
const Product = require('../models/Product');
const Block = require('../models/Block');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const OrderingSession = require('../models/OrderingSession');
const Counter = require('../models/Counter');
const ShopAuditLog = require('../models/ShopAuditLog');
const AppSetting = require('../models/AppSetting');
const cache = require('../utils/cache');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const {
  isOrderingOpen,
  getOpenDateWarsaw,
  getOrderingWindowOpenAt,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { signSession } = require('../utils/jwt');
const { auditSessionClosure } = require('../services/sessionClosure');
const { archiveOrphanedOutOfStockProducts } = require('../services/pickingService');
const { reconcileLateOrderStrict } = require('../services/lateOrderReconcile');

const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const MARKER = `__LIVE_E2E__${RUN_ID}`;
const MANIFEST_KEY = `live-e2e.run.${RUN_ID}`;
const REPORT_DIR = path.resolve(__dirname, '../test-reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

let syntheticOrderNumber = 910_000_000 + crypto.randomInt(0, 50_000_000);
const originalCounterFindOneAndUpdate = Counter.findOneAndUpdate.bind(Counter);
Counter.findOneAndUpdate = function liveE2ECounterIsolation(filter, update, options) {
  if (filter && filter.name === 'orderNumber') {
    syntheticOrderNumber += 1;
    return Promise.resolve({ name: 'orderNumber', seq: syntheticOrderNumber });
  }
  return originalCounterFindOneAndUpdate(filter, update, options);
};

const assertions = [];
const scenarioResults = [];
const preservedWorlds = [];
let localServer = null;
let baseUrl = '';
let manifestValue = null;

async function initRunManifest() {
  manifestValue = {
    runId: RUN_ID,
    marker: MARKER,
    startedAt: new Date().toISOString(),
    status: 'running',
    worlds: {},
  };
  await AppSetting.findOneAndUpdate(
    { key: MANIFEST_KEY },
    { $set: { value: manifestValue } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function updateWorldManifest(world, extra = {}) {
  if (!manifestValue || !world) return;
  const previous = manifestValue.worlds[world.name] || {};
  const next = {
    ...previous,
    scenario: world.name,
    groupId: str(world.group?._id || previous.groupId),
    shopIds: (world.shops || []).map((x) => str(x?._id)).filter(Boolean),
    userTelegramIds: (world.users || []).map((x) => str(x?.telegramId)).filter(Boolean),
    productIds: (world.products || []).map((x) => str(x?._id)).filter(Boolean),
    blockMongoId: str(world.block?._id || previous.blockMongoId),
    blockId: world.block?.blockId ?? previous.blockId ?? null,
    sessionIds: [...(world.sessionIds || [])].map(str).filter(Boolean),
    orderIds: [...(world.orderIds || [])].map(str).filter(Boolean),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  manifestValue.worlds[world.name] = next;
  await AppSetting.updateOne({ key: MANIFEST_KEY }, { $set: { value: manifestValue } });
}

async function markWorldCleaned(world) {
  if (!manifestValue || !world) return;
  if (manifestValue.worlds[world.name]) {
    manifestValue.worlds[world.name].cleanedAt = new Date().toISOString();
    manifestValue.worlds[world.name].clean = true;
    await AppSetting.updateOne({ key: MANIFEST_KEY }, { $set: { value: manifestValue } });
  }
}

async function finishRunManifest({ preserve = false } = {}) {
  if (!manifestValue) return;
  if (preserve) {
    manifestValue.status = 'preserved';
    manifestValue.finishedAt = new Date().toISOString();
    await AppSetting.updateOne({ key: MANIFEST_KEY }, { $set: { value: manifestValue } });
    return;
  }
  await AppSetting.deleteOne({ key: MANIFEST_KEY });
  manifestValue = null;
}

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function str(v) { return v == null ? '' : String(v); }
function terminalItem(i) { return Boolean(i?.packed || i?.cancelled || i?.skipped); }

function log(msg = '') { console.log(msg); }
function section(title) {
  log(`\n${'═'.repeat(88)}\n${title}\n${'═'.repeat(88)}`);
}
function pass(name, details = '') {
  assertions.push({ ok: true, name, details });
  console.log(`  ✅ ${name}${details ? ` — ${details}` : ''}`);
}
function fail(name, details = '') {
  assertions.push({ ok: false, name, details });
  console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`);
  const e = new Error(details || name);
  e.assertionName = name;
  throw e;
}
function check(condition, name, details = '') {
  if (condition) pass(name, details);
  else fail(name, details);
}
function eq(actual, expected, name) {
  check(actual === expected, name, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function includes(arr, value, name) {
  check(Array.isArray(arr) && arr.includes(value), name, `value=${value}`);
}

function selected(name) {
  return !requestedScenarios || requestedScenarios.has(name);
}

function makeTelegramId(index) {
  // Synthetic, non-real namespace; kept numeric-looking because some UI/API code
  // assumes telegram ids are strings containing digits.
  const tail = `${Date.now()}${crypto.randomInt(1000, 9999)}${index}`.slice(-14);
  return `-99${tail}`;
}

async function allocProductOrderNumbers(count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = 1_500_000_000 + crypto.randomInt(0, 300_000_000);
    const nums = Array.from({ length: count }, (_, i) => base + i);
    const exists = await Product.exists({ orderNumber: { $in: nums }, status: { $ne: 'archived' } });
    if (!exists) return nums;
  }
  throw new Error('Не вдалося виділити безпечний synthetic Product.orderNumber range');
}

async function allocBlockId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = 900_000_000 + crypto.randomInt(0, 90_000_000);
    if (!(await Block.exists({ blockId: id }))) return id;
  }
  throw new Error('Не вдалося виділити synthetic blockId');
}

function findOpenDeliveryDay(schedule) {
  for (let d = 0; d < 7; d += 1) if (isOrderingOpen(d, schedule).isOpen) return d;
  return null;
}
function findClosedDeliveryDay(schedule) {
  for (let d = 0; d < 7; d += 1) if (!isOrderingOpen(d, schedule).isOpen) return d;
  return null;
}

async function createWorld(name, {
  shops = 1,
  sellers = 1,
  warehouse = 2,
  products = 1,
  sellerShopIndexes = null,
} = {}) {
  const world = {
    name, schedule: null, group: null, shops: [], sellers: [], warehouses: [], users: [], products: [], block: null,
    sessionIds: new Set(), orderIds: new Set(),
  };
  try {
    const schedule = await getOrderingSchedule();
    world.schedule = schedule;
    const openDay = findOpenDeliveryDay(schedule);
    if (openDay == null) {
      throw new Error(
        'Зараз немає жодного dayOfWeek з відкритим ordering window. ' +
        'HTTP-ordering сценарії навмисно не підміняють бойовий schedule. Запусти suite у вікні замовлень.'
      );
    }

    const token = crypto.randomBytes(3).toString('hex');
    const group = await DeliveryGroup.create({
      name: `${MARKER}:${name}:group:${token}`,
      dayOfWeek: openDay,
      members: [],
    });
    world.group = group;
    await updateWorldManifest(world, { phase: 'group_created' });
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);

    for (let i = 0; i < shops; i += 1) {
      world.shops.push(await Shop.create({
        name: `${MARKER}:${name}:shop:${i + 1}`,
        address: `TEST ${i + 1}`,
        deliveryGroupId: str(group._id),
        isActive: true,
      }));
      await updateWorldManifest(world, { phase: 'shops_creating' });
    }

    for (let i = 0; i < sellers; i += 1) {
      const shopIndex = sellerShopIndexes ? sellerShopIndexes[i] : Math.min(i, world.shops.length - 1);
      const u = await User.create({
        telegramId: makeTelegramId(i + 1),
        role: 'seller',
        firstName: `E2E_${name}_S${i + 1}`,
        lastName: RUN_ID,
        shopId: world.shops[shopIndex]?._id || null,
      });
      world.sellers.push(u);
      world.users.push(u);
      await updateWorldManifest(world, { phase: 'users_creating' });
    }
    for (let i = 0; i < warehouse; i += 1) {
      const u = await User.create({
        telegramId: makeTelegramId(100 + i),
        role: 'warehouse',
        firstName: `E2E_${name}_W${i + 1}`,
        lastName: RUN_ID,
      });
      world.warehouses.push(u);
      world.users.push(u);
      await updateWorldManifest(world, { phase: 'users_creating' });
    }

    const orderNumbers = await allocProductOrderNumbers(products);
    for (let i = 0; i < products; i += 1) {
      world.products.push(await Product.create({
        orderNumber: orderNumbers[i],
        price: Number((1.25 + i).toFixed(2)),
        quantity: 999,
        name: `${MARKER}:${name}:product:${i + 1}`,
        brand: `${MARKER}:${name}:P${i + 1}`,
        status: 'active',
        source: 'live_e2e',
      }));
      await updateWorldManifest(world, { phase: 'products_creating' });
    }

    const blockId = await allocBlockId();
    world.block = await Block.create({ blockId, productIds: world.products.map((p) => p._id), version: 1 });
    await updateWorldManifest(world, { phase: 'ready' });
    return world;
  } catch (e) {
    e.world = world;
    try { await updateWorldManifest(world, { phase: 'create_failed', failed: true, error: e.message }); } catch { /* preserve original */ }
    throw e;
  }
}

async function cleanupWorld(world) {
  if (!world) return;
  const groupId = str(world.group?._id);
  const userIds = (world.users || []).map((u) => str(u.telegramId)).filter(Boolean);
  const shopIds = (world.shops || []).map((s) => s._id).filter(Boolean);
  const productIds = (world.products || []).map((p) => p._id).filter(Boolean);

  // A first pass removes business data before parent fixtures.
  if (groupId) {
    const sessions = await OrderingSession.find({ groupId }, '_id').lean();
    const sessionIds = sessions.map((s) => str(s._id));
    await PickingTask.deleteMany({
      $or: [
        { deliveryGroupId: groupId },
        ...(sessionIds.length ? [{ orderingSessionId: { $in: sessionIds } }] : []),
        ...(productIds.length ? [{ productId: { $in: productIds } }] : []),
      ],
    });
    await OrderingSession.deleteMany({ groupId });
    await Counter.deleteMany({ name: `session-seq:${groupId}` });
  }
  if (userIds.length) {
    await Order.deleteMany({ buyerTelegramId: { $in: userIds } });
    await ShopAuditLog.deleteMany({
      $or: [
        { sellerTelegramId: { $in: userIds } },
        { actorTelegramId: { $in: userIds } },
      ],
    });
  }
  if (world.block?._id) await Block.deleteOne({ _id: world.block._id });
  if (productIds.length) await Product.deleteMany({ _id: { $in: productIds } });
  if (userIds.length) await User.deleteMany({ telegramId: { $in: userIds } });
  if (shopIds.length) await Shop.deleteMany({ _id: { $in: shopIds } });
  if (groupId) await DeliveryGroup.deleteOne({ _id: world.group._id });

  // Fire-and-forget ensureSessionSeq can finish just after an order response.
  // Give it one beat, then scrub the group-scoped counter/session one more time.
  await sleep(120);
  if (groupId) {
    await OrderingSession.deleteMany({ groupId });
    await Counter.deleteMany({ name: `session-seq:${groupId}` });
  }
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
}

async function verifyWorldClean(world) {
  if (!world) return true;
  const groupId = str(world.group?._id);
  const userIds = (world.users || []).map((u) => str(u.telegramId)).filter(Boolean);
  const shopIds = (world.shops || []).map((s) => s._id).filter(Boolean);
  const productIds = (world.products || []).map((p) => p._id).filter(Boolean);
  const counts = await Promise.all([
    groupId ? DeliveryGroup.countDocuments({ _id: world.group._id }) : 0,
    groupId ? OrderingSession.countDocuments({ groupId }) : 0,
    groupId ? PickingTask.countDocuments({ deliveryGroupId: groupId }) : 0,
    userIds.length ? Order.countDocuments({ buyerTelegramId: { $in: userIds } }) : 0,
    userIds.length ? User.countDocuments({ telegramId: { $in: userIds } }) : 0,
    shopIds.length ? Shop.countDocuments({ _id: { $in: shopIds } }) : 0,
    productIds.length ? Product.countDocuments({ _id: { $in: productIds } }) : 0,
    world.block?._id ? Block.countDocuments({ _id: world.block._id }) : 0,
    userIds.length ? ShopAuditLog.countDocuments({ sellerTelegramId: { $in: userIds } }) : 0,
    groupId ? Counter.countDocuments({ name: `session-seq:${groupId}` }) : 0,
  ]);
  return counts.every((n) => Number(n) === 0);
}

async function tokenFor(user) {
  return signSession(str(user.telegramId));
}

async function api(method, urlPath, user = null, body = undefined) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await tokenFor(user)}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { _raw: text }; }
  return { status: res.status, data };
}

async function placeOrder(world, seller, items, suffix) {
  const response = await api('POST', '/api/v1/orders', seller, {
    buyerTelegramId: str(seller.telegramId),
    items: items.map(({ product, quantity }) => ({ productId: str(product._id), quantity })),
    idempotencyKey: `${MARKER}:${world.name}:idem:${suffix}:${crypto.randomBytes(2).toString('hex')}`,
  });
  check([200, 201].includes(response.status), `${world.name}: HTTP order accepted`, `status=${response.status} error=${response.data?.error || ''}`);
  if (response.data?._id) world.orderIds.add(str(response.data._id));
  if (response.data?.orderingSessionId) world.sessionIds.add(str(response.data.orderingSessionId));
  await updateWorldManifest(world, { phase: 'orders_active' });
  return response.data;
}

async function currentSession(world) {
  const sessionId = await getOrCreateSessionId(str(world.group._id), world.group.dayOfWeek, world.schedule);
  world.sessionIds.add(str(sessionId));
  await updateWorldManifest(world);
  return OrderingSession.findById(sessionId);
}

async function moveWorldToClosedPhase(world) {
  const session = await currentSession(world);
  const closedDay = findClosedDeliveryDay(world.schedule);
  if (closedDay == null) throw new Error('Не знайдено закритого delivery day для тестового переходу');

  // We are simulating time advancing, but only on synthetic data. Keep the SAME
  // OrderingSession._id referenced by all test Orders: retag its test-only
  // calendar identity to the closed day's current openDate, then switch the
  // synthetic group day. No global schedule and no real group is changed.
  const closedOpenDate = getOpenDateWarsaw(closedDay, world.schedule);
  const closedOpenAt = getOrderingWindowOpenAt(closedDay, world.schedule);
  // Production readers should not normally know this synthetic group, but if one
  // happened to discover it during the few seconds of the run and pre-created a
  // session for the closed calendar date, it is still TEST-OWNED data. Remove that
  // empty competing identity before retagging our actual test session.
  await OrderingSession.deleteMany({
    groupId: str(world.group._id), openDate: closedOpenDate, _id: { $ne: session._id },
  });
  await OrderingSession.updateOne(
    { _id: session._id },
    { $set: { openDate: closedOpenDate, openAt: closedOpenAt } },
  );
  await DeliveryGroup.updateOne({ _id: world.group._id }, { $set: { dayOfWeek: closedDay } });
  world.group.dayOfWeek = closedDay;
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);

  const resolved = await getOrCreateSessionId(str(world.group._id), closedDay, world.schedule);
  eq(str(resolved), str(session._id), `${world.name}: ordering session identity survives open→closed test phase`);
  check(!isOrderingOpen(closedDay, world.schedule).isOpen, `${world.name}: picking phase window is closed`);
  return OrderingSession.findById(session._id);
}

async function startPicking(world, warehouse, confirm = true) {
  return api('POST', '/api/picking/start-session', warehouse, {
    deliveryGroupId: str(world.group._id),
    confirm,
  });
}

async function getPendingTasks(world, sessionId) {
  return PickingTask.find({ orderingSessionId: str(sessionId), status: 'pending' }).sort({ blockId: 1, positionIndex: 1 }).lean();
}

async function claimTask(warehouse, taskId) {
  const r = await api('POST', `/api/picking/tasks/${taskId}/claim`, warehouse, {});
  check(r.status === 200 && r.data?.task, 'Task claim succeeds', `status=${r.status} error=${r.data?.error || ''}`);
  return r.data.task;
}

async function completeTask(warehouse, taskId, items) {
  const r = await api('POST', `/api/picking/tasks/${taskId}/complete`, warehouse, { items });
  check(r.status === 200, 'Task complete endpoint succeeds', `status=${r.status} error=${r.data?.error || ''}`);
  return r.data;
}

async function completeEveryPendingTask(world, warehouse, sessionId) {
  for (;;) {
    // /complete automatically locks the next forward task for the same worker.
    // Consume that owned lock first; otherwise a helper that looks only for
    // `pending` would stop after the first product and leave the auto-advanced
    // task stranded in `locked`.
    let task = await PickingTask.findOne({
      orderingSessionId: str(sessionId), status: 'locked', lockedBy: str(warehouse.telegramId),
    }).sort({ blockId: 1, positionIndex: 1 }).lean();
    if (!task) {
      task = await PickingTask.findOne({ orderingSessionId: str(sessionId), status: 'pending' })
        .sort({ blockId: 1, positionIndex: 1 }).lean();
      if (!task) break;
      await claimTask(warehouse, task._id);
      task = await PickingTask.findById(task._id).lean();
    }
    await completeTask(warehouse, task._id, task.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
  }
}

async function assertSessionCompleted(sessionId, label) {
  const s = await OrderingSession.findById(sessionId).lean();
  eq(s?.pickingStatus, 'completed', `${label}: session completed`);
  check(Boolean(s?.pickingCompletedAt), `${label}: pickingCompletedAt stamped`);
  return s;
}

async function scenarioHappy() {
  const world = await createWorld('happy', { shops: 1, sellers: 1, warehouse: 1, products: 2 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const first = await placeOrder(world, seller, [{ product: world.products[0], quantity: 2 }], 'a');
    const second = await placeOrder(world, seller, [{ product: world.products[1], quantity: 3 }], 'b');
    eq(str(second._id), str(first._id), 'happy: repeated seller submit merges into the SAME Order');
    const sid = str(second.orderingSessionId);
    const activeCount = await Order.countDocuments({
      buyerTelegramId: str(seller.telegramId), shopId: world.shops[0]._id,
      orderingSessionId: sid, status: { $in: ['new', 'in_progress'] },
    });
    eq(activeCount, 1, 'happy: DB invariant = one active Order per seller+shop+session');
    const dbOrder = await Order.findById(first._id).lean();
    eq(dbOrder.items.filter((i) => !terminalItem(i)).length, 2, 'happy: one Order contains multiple product positions');

    // Navigation-state compatibility: seed legacy cart fields, then send the
    // payload shape used by an OLD client (including empty orderItems arrays).
    // The navigation endpoint must update only the cursor and leave those legacy
    // snapshots untouched. A second save must also succeed without cart_stale.
    const legacyProbeId = str(world.products[0]._id);
    await User.updateOne(
      { telegramId: str(seller.telegramId) },
      { $set: {
        [`cartState.orderItems.${legacyProbeId}`]: 7,
        'cartState.orderItemIds': [legacyProbeId],
      } },
    );
    const stateSave1 = await api('POST', '/api/v1/telegram/mini-app/state', seller, {
      currentIndex: 1,
      currentPage: 0,
      productId: str(world.products[1]._id),
      orderNumber: world.products[1].orderNumber || 0,
      orderItems: {},
      orderItemIds: [],
      orderingSessionId: sid,
    });
    eq(stateSave1.status, 200, 'happy: navigation state accepts legacy payload without cart_stale');
    const afterState1 = await User.findOne({ telegramId: str(seller.telegramId) }).lean();
    eq(Number(afterState1?.cartState?.orderItems?.[legacyProbeId] ?? afterState1?.cartState?.orderItems?.get?.(legacyProbeId)), 7, 'happy: navigation save does not erase legacy cartState.orderItems');
    check((afterState1?.cartState?.orderItemIds || []).map(String).includes(legacyProbeId), 'happy: navigation save does not erase legacy cartState.orderItemIds');
    const stateSave2 = await api('POST', '/api/v1/telegram/mini-app/state', seller, {
      currentIndex: 0,
      currentPage: 0,
      productId: str(world.products[0]._id),
      orderNumber: world.products[0].orderNumber || 0,
      orderingSessionId: sid,
    });
    eq(stateSave2.status, 200, 'happy: repeated navigation save is last-write-wins (no stale revision 409)');

    // Hit the REAL partial unique index directly. The HTTP layer should normally
    // merge, but even a race/bypass must not be able to persist a second active
    // Order for the same seller+shop+orderingSession.
    let duplicateBlocked = false;
    try {
      await Order.create({
        buyerTelegramId: str(seller.telegramId),
        shopId: world.shops[0]._id,
        orderingSessionId: sid,
        status: 'new',
        orderNumber: ++syntheticOrderNumber,
        buyerSnapshot: dbOrder.buyerSnapshot,
        items: [{
          productId: world.products[0]._id, name: world.products[0].name,
          price: world.products[0].price, quantity: 1, packed: false, cancelled: false, skipped: false,
        }],
        totalPrice: world.products[0].price,
        history: [{ action: 'live_e2e_duplicate_probe' }],
      });
    } catch (err) {
      duplicateBlocked = err?.code === 11000;
    }
    check(duplicateBlocked, 'happy: LIVE Mongo unique index rejects second active Order for same seller+shop+session');

    await moveWorldToClosedPhase(world);
    const pre = await startPicking(world, wh, false);
    check(pre.status === 200 && pre.data?.preStart === true, 'happy: pre-start phase is visible before confirmation');
    const start = await startPicking(world, wh, true);
    check(start.status === 200 && start.data?.started === true, 'happy: picking start confirmed');
    eq(start.data?.taskCount, 2, 'happy: two product PickingTasks built');

    const session = await currentSession(world);
    eq((await OrderingSession.findById(session._id).lean()).pickingStatus, 'confirmed', 'happy: picking is confirmed before first physical claim');
    const tasks = await getPendingTasks(world, session._id);
    const firstTask = tasks[0];
    await claimTask(wh, firstTask._id);
    eq((await OrderingSession.findById(session._id).lean()).pickingStatus, 'in_progress', 'happy: first physical claim starts picking in_progress');

    const heartbeat = await api('POST', `/api/picking/tasks/${firstTask._id}/heartbeat`, wh, {});
    check(heartbeat.status === 200 && heartbeat.data?.held === true, 'happy: locked task heartbeat preserves lease');

    const progress = await api('PATCH', `/api/picking/tasks/${firstTask._id}/progress`, wh, {
      packedOrderIds: firstTask.items.map((i) => str(i.orderId)),
    });
    check(progress.status === 200 && progress.data?.ok === true, 'happy: partial server-side progress is persisted before completion');
    const afterProgress = await PickingTask.findById(firstTask._id).lean();
    check(afterProgress.items.every((i) => i.packed === true), 'happy: DB PickingTask contains saved checkbox progress');

    await completeTask(wh, firstTask._id, firstTask.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await completeEveryPendingTask(world, wh, session._id);
    await assertSessionCompleted(session._id, 'happy');
    const doneOrder = await Order.findById(first._id).lean();
    eq(doneOrder.status, 'fulfilled', 'happy: Order fulfilled after all product tasks');
    check(doneOrder.items.every((i) => i.packed && i.packedQuantity === i.quantity), 'happy: every order item has real packed quantity');
    const closure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(session._id) });
    check(closure.ok, 'happy: closure audit is clean');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioRemoveLast() {
  const world = await createWorld('remove_last', { shops: 1, sellers: 1, warehouse: 1, products: 1 });
  try {
    const seller = world.sellers[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 2 }], 'single');
    const r = await api('POST', '/api/v1/orders/remove-item', seller, { productId: str(world.products[0]._id) });
    eq(r.status, 200, 'remove_last: seller remove-item succeeds');
    const after = await Order.findById(order._id).lean();
    eq(after, null, 'remove_last: never-picked Order is deleted when seller removes final position');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioConflictMove() {
  const world = await createWorld('conflict_move', {
    shops: 2, sellers: 3, warehouse: 1, products: 1,
    sellerShopIndexes: [0, 0, 1], // seller3 occupies target shop but has NO order
  });
  try {
    const [a, b] = world.sellers;
    const wh = world.warehouses[0];
    await placeOrder(world, a, [{ product: world.products[0], quantity: 1 }], 'a');
    await placeOrder(world, b, [{ product: world.products[0], quantity: 1 }], 'b');
    await moveWorldToClosedPhase(world);

    const blocked = await startPicking(world, wh, true);
    check(blocked.status === 200 && blocked.data?.unresolved === true, 'conflict_move: 2 buyers with active Orders on one shop block picking START');
    eq(await PickingTask.countDocuments({ orderingSessionId: str((await currentSession(world))._id) }), 0, 'conflict_move: no PickingTask built while conflict exists');

    const move = await api('POST', '/api/v1/orders/conflicts/resolve', wh, {
      shopId: str(world.shops[0]._id), buyerTelegramId: str(b.telegramId), action: 'move', toShopId: str(world.shops[1]._id),
    });
    eq(move.status, 200, 'conflict_move: seller can move into active shop already containing seller without an Order');
    const movedUser = await User.findOne({ telegramId: str(b.telegramId) }).lean();
    eq(str(movedUser.shopId), str(world.shops[1]._id), 'conflict_move: seller assignment moved');

    const start = await startPicking(world, wh, true);
    check(start.status === 200 && start.data?.started === true, 'conflict_move: start succeeds after conflict resolution');
    const session = await currentSession(world);
    const task = await PickingTask.findOne({ orderingSessionId: str(session._id), status: 'pending' }).lean();
    eq(task.items.length, 2, 'conflict_move: same product task contains both resolved shops');
    await claimTask(wh, task._id);
    await completeTask(wh, task._id, task.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await assertSessionCompleted(session._id, 'conflict_move');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioConflictRelocate() {
  const world = await createWorld('conflict_relocate', {
    shops: 2, sellers: 3, warehouse: 1, products: 1,
    sellerShopIndexes: [0, 0, 1],
  });
  try {
    const [a, b, c] = world.sellers;
    const wh = world.warehouses[0];
    await placeOrder(world, a, [{ product: world.products[0], quantity: 1 }], 'a');
    await placeOrder(world, b, [{ product: world.products[0], quantity: 1 }], 'b');
    await placeOrder(world, c, [{ product: world.products[0], quantity: 1 }], 'c');
    await moveWorldToClosedPhase(world);

    const blockedA = await startPicking(world, wh, true);
    check(blockedA.data?.unresolved === true, 'conflict_relocate: initial source-shop conflict blocks start');

    const move = await api('POST', '/api/v1/orders/conflicts/resolve', wh, {
      shopId: str(world.shops[0]._id), buyerTelegramId: str(b.telegramId), action: 'move', toShopId: str(world.shops[1]._id),
    });
    eq(move.status, 200, 'conflict_relocate: permissive move to shop with another ACTIVE Order is allowed');

    const blockedB = await startPicking(world, wh, true);
    check(blockedB.data?.unresolved === true, 'conflict_relocate: conflict relocates to target and STILL blocks picking start');
    const conflictShopNames = (blockedB.data?.conflicts || []).map((x) => x.shopName);
    includes(conflictShopNames, world.shops[1].name, 'conflict_relocate: target shop is reported as the new conflict');

    const unassign = await api('POST', '/api/v1/orders/conflicts/resolve', wh, {
      shopId: str(world.shops[1]._id), buyerTelegramId: str(b.telegramId), action: 'unassign',
    });
    eq(unassign.status, 200, 'conflict_relocate: operator can unassign after relocated conflict');

    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'conflict_relocate: start succeeds only after all current conflicts are gone');
    const session = await currentSession(world);
    await completeEveryPendingTask(world, wh, session._id);
    await assertSessionCompleted(session._id, 'conflict_relocate');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioConflictUnassign() {
  const world = await createWorld('conflict_unassign', { shops: 1, sellers: 2, warehouse: 1, products: 1, sellerShopIndexes: [0, 0] });
  try {
    const [a, b] = world.sellers;
    const wh = world.warehouses[0];
    await placeOrder(world, a, [{ product: world.products[0], quantity: 1 }], 'a');
    const bOrder = await placeOrder(world, b, [{ product: world.products[0], quantity: 1 }], 'b');
    await moveWorldToClosedPhase(world);
    const blocked = await startPicking(world, wh, true);
    check(blocked.data?.unresolved === true, 'conflict_unassign: conflict blocks start before unassign');

    const unassign = await api('POST', '/api/v1/orders/conflicts/resolve', wh, {
      shopId: str(world.shops[0]._id), buyerTelegramId: str(b.telegramId), action: 'unassign',
    });
    eq(unassign.status, 200, 'conflict_unassign: unassign action succeeds');
    const parked = await Order.findById(bOrder._id).lean();
    eq(str(parked.shopId), '', 'conflict_unassign: Order top-level shop cleared');
    eq(str(parked.buyerSnapshot?.deliveryGroupId), '', 'conflict_unassign: parked Order leaves old delivery group');

    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'conflict_unassign: picking starts with remaining valid Order');
    const session = await currentSession(world);
    await completeEveryPendingTask(world, wh, session._id);
    await assertSessionCompleted(session._id, 'conflict_unassign');
    const closure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(session._id) });
    check(closure.ok, 'conflict_unassign: parked Order does NOT block closure');
    includes(closure.warnings.map((w) => w.code), 'parked_session_orders', 'conflict_unassign: parked Order is visible as warning');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioCoverage() {
  const world = await createWorld('coverage', { shops: 1, sellers: 1, warehouse: 1, products: 1 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 2 }], 'gap');
    await moveWorldToClosedPhase(world);
    await Block.updateOne({ _id: world.block._id }, { $pull: { productIds: world.products[0]._id }, $inc: { version: 1 } });

    const blocked = await startPicking(world, wh, true);
    check(blocked.status === 200 && blocked.data?.coverageGaps === true, 'coverage: missing floor location blocks picking start visibly');
    includes((blocked.data?.gaps || []).map((g) => g.reason), 'no_block', 'coverage: gap reason is no_block');
    const session = await currentSession(world);
    eq((await OrderingSession.findById(session._id).lean()).pickingStatus, 'pending', 'coverage: session remains pending while gap exists');

    const repair = await api('POST', '/api/picking/resolve-coverage-gap', wh, {
      deliveryGroupId: str(world.group._id), productId: str(world.products[0]._id),
    });
    check(repair.status === 200 && repair.data?.resolved === true, 'coverage: operator gap repair resolves coverage');
    const repairedOrder = await Order.findById(order._id).lean();
    check(repairedOrder.items[0].cancelled === true, 'coverage: missing product position gets terminal cancelled marker');
    eq((await Product.findById(world.products[0]._id).lean()).status, 'archived', 'coverage: missing product archived by repair');

    const start = await startPicking(world, wh, true);
    check(start.status === 200 && start.data?.noOrders === true, 'coverage: empty-after-repair session closes cleanly');
    await assertSessionCompleted(session._id, 'coverage');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function createDirectOldOrder(world, { sessionId, seller, shop, product, qty = 1 }) {
  const order = await Order.create({
    buyerTelegramId: str(seller.telegramId),
    shopId: shop._id,
    orderingSessionId: str(sessionId),
    status: 'new',
    orderNumber: ++syntheticOrderNumber,
    buyerSnapshot: {
      shopId: shop._id, shopName: shop.name, shopCity: '', shopAddress: shop.address,
      deliveryGroupId: str(world.group._id),
    },
    items: [{ productId: product._id, name: product.name, price: product.price, quantity: qty, packed: false, cancelled: false, skipped: false }],
    totalPrice: product.price * qty,
    history: [{ action: 'live_e2e_old_order' }],
  });
  world.orderIds.add(str(order._id));
  await updateWorldManifest(world);
  return order;
}

async function scenarioIsolation() {
  const world = await createWorld('isolation', { shops: 2, sellers: 2, warehouse: 1, products: 1, sellerShopIndexes: [0, 1] });
  try {
    const [currentSeller, oldSeller] = world.sellers;
    const wh = world.warehouses[0];
    const currentOrder = await placeOrder(world, currentSeller, [{ product: world.products[0], quantity: 2 }], 'current');
    const currentSid = str(currentOrder.orderingSessionId);

    const curSession = await OrderingSession.findById(currentSid).lean();
    const oldDate = new Date(`${curSession.openDate}T00:00:00.000Z`);
    oldDate.setUTCDate(oldDate.getUTCDate() - 7);
    const oldOpenDate = oldDate.toISOString().slice(0, 10);
    const oldSession = await OrderingSession.create({
      groupId: str(world.group._id), openDate: oldOpenDate,
      openAt: new Date(Date.now() - 7 * 24 * 3600 * 1000), pickingStatus: 'confirmed',
      pickingConfirmedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000),
      events: [{ type: 'created' }, { type: 'picking_confirmed' }],
    });
    world.sessionIds.add(str(oldSession._id));
    await updateWorldManifest(world, { phase: 'old_session_fixture' });
    const oldOrder = await createDirectOldOrder(world, {
      sessionId: oldSession._id, seller: oldSeller, shop: world.shops[1], product: world.products[0], qty: 1,
    });
    const oldTask = await PickingTask.create({
      productId: world.products[0]._id,
      deliveryGroupId: str(world.group._id), orderingSessionId: str(oldSession._id),
      blockId: world.block.blockId, positionIndex: 1, status: 'pending',
      items: [{ orderId: oldOrder._id, shopId: world.shops[1]._id, shopName: world.shops[1].name, quantity: 1, packed: false }],
    });

    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.status === 200 && start.data?.started === true, 'isolation: old active order/task do NOT block new session start');
    check((start.data?.staleWarnings || []).some((w) => str(w.orderId) === str(oldOrder._id)), 'isolation: old active Order is surfaced as stale warning');
    const currentTask = await PickingTask.findOne({ orderingSessionId: currentSid, status: 'pending', productId: world.products[0]._id }).lean();
    check(Boolean(currentTask), 'isolation: same product gets a NEW current-session task despite old pending task');
    check(str(currentTask._id) !== str(oldTask._id), 'isolation: old/new PickingTasks are distinct documents');

    await claimTask(wh, currentTask._id);
    await completeTask(wh, currentTask._id, currentTask.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await assertSessionCompleted(currentSid, 'isolation');
    eq((await PickingTask.findById(oldTask._id).lean()).status, 'pending', 'isolation: old task remains historical/repair data, untouched');
    const closure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: currentSid });
    check(closure.ok, 'isolation: old debris does not block current closure');
    includes(closure.warnings.map((w) => w.code), 'orphan_tasks', 'isolation: old task visible as orphan warning');
    includes(closure.warnings.map((w) => w.code), 'stale_orders', 'isolation: old order visible as stale warning');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioBarrier() {
  const world = await createWorld('barrier', { shops: 1, sellers: 1, warehouse: 2, products: 2 });
  try {
    const seller = world.sellers[0];
    const [wa, wb] = world.warehouses;
    const order = await placeOrder(world, seller, [
      { product: world.products[0], quantity: 1 }, { product: world.products[1], quantity: 1 },
    ], 'route');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wa, true);
    check(start.data?.started === true, 'barrier: picking session starts');
    const sid = str(order.orderingSessionId);
    const tasks = await getPendingTasks(world, sid);
    eq(tasks.length, 2, 'barrier: two sequential tasks available');

    await claimTask(wb, tasks[1]._id); // worker B ahead
    await claimTask(wa, tasks[0]._id); // worker A behind
    const doneA = await completeTask(wa, tasks[0]._id, tasks[0].items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    eq(doneA.routeBlocked?.code, 'worker_ahead', 'barrier: worker ahead is a hard physical route barrier');
    eq(doneA.nextTask, null, 'barrier: worker A does NOT jump over locked worker B');
    eq((await OrderingSession.findById(sid).lean()).pickingStatus, 'in_progress', 'barrier: session stays in progress while B owns next task');

    const freshB = await PickingTask.findById(tasks[1]._id).lean();
    await completeTask(wb, tasks[1]._id, freshB.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await assertSessionCompleted(sid, 'barrier');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioShortPick() {
  const world = await createWorld('short_pick', { shops: 1, sellers: 1, warehouse: 1, products: 1 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 5 }], 'short');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'short_pick: picking starts');
    const task = (await getPendingTasks(world, order.orderingSessionId))[0];
    await claimTask(wh, task._id);
    await completeTask(wh, task._id, [{ orderId: str(task.items[0].orderId), actualQty: 3 }]);
    const o = await Order.findById(order._id).lean();
    eq(o.status, 'fulfilled', 'short_pick: processed partial delivery is still terminal/fulfilled Order');
    eq(o.items[0].packedQuantity, 3, 'short_pick: actual packed quantity persisted');
    eq(o.items[0].shortfallReason, 'short_pick', 'short_pick: shortfall reason persisted');
    const t = await PickingTask.findById(task._id).lean();
    eq(t.completionReason, 'packed', 'short_pick: task cause remains normal packed, not OOS');
    await assertSessionCompleted(order.orderingSessionId, 'short_pick');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioOOS() {
  const world = await createWorld('oos', { shops: 2, sellers: 2, warehouse: 1, products: 2, sellerShopIndexes: [0, 1] });
  try {
    const [a, b] = world.sellers;
    const wh = world.warehouses[0];
    const orderA = await placeOrder(world, a, [
      { product: world.products[0], quantity: 2 }, { product: world.products[1], quantity: 1 },
    ], 'a');
    const orderB = await placeOrder(world, b, [{ product: world.products[0], quantity: 2 }], 'b');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'oos: picking starts');

    const oosTask = await PickingTask.findOne({ orderingSessionId: str(orderA.orderingSessionId), productId: world.products[0]._id, status: 'pending' }).lean();
    await claimTask(wh, oosTask._id);
    const oosResp = await api('POST', `/api/picking/tasks/${oosTask._id}/out-of-stock`, wh, {
      packedOrderIds: [str(orderA._id)],
    });
    eq(oosResp.status, 200, 'oos: out-of-stock endpoint succeeds');
    const t = await PickingTask.findById(oosTask._id).lean();
    eq(t.completionReason, 'out_of_stock', 'oos: task records canonical out_of_stock cause');
    eq((await Product.findById(world.products[0]._id).lean()).status, 'archived', 'oos: product archived');
    const oaMid = await Order.findById(orderA._id).lean();
    const obMid = await Order.findById(orderB._id).lean();
    const aOos = oaMid.items.find((i) => str(i.productId) === str(world.products[0]._id));
    const bOos = obMid.items.find((i) => str(i.productId) === str(world.products[0]._id));
    check(aOos.packed === true && aOos.packedQuantity === 2, 'oos: already-served shop stays physically packed');
    check(bOos.cancelled === true && bOos.packed === false, 'oos: unserved shop gets terminal cancelled position');
    eq(obMid.status, 'cancelled', 'oos: all-OOS Order becomes cancelled');

    await completeEveryPendingTask(world, wh, orderA.orderingSessionId);
    await assertSessionCompleted(orderA.orderingSessionId, 'oos');
    const oaDone = await Order.findById(orderA._id).lean();
    eq(oaDone.status, 'fulfilled', 'oos: served shop completes after its remaining product');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioLateOrder() {
  const world = await createWorld('late_order', { shops: 2, sellers: 2, warehouse: 1, products: 2, sellerShopIndexes: [0, 1] });
  try {
    const [onTimeSeller, lateSeller] = world.sellers;
    const wh = world.warehouses[0];
    const onTime = await placeOrder(world, onTimeSeller, [{ product: world.products[0], quantity: 1 }], 'on-time');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'late_order: picking plan starts from on-time snapshot');
    const sid = str(onTime.orderingSessionId);

    // Abnormal-but-supported source: an Order appears after the pick plan froze.
    // We insert only TEST-owned data, then run the real strict late reconcile.
    // Product #1 still has a PENDING task and may ride along; product #2 has no
    // task in the frozen plan and must become terminal `skipped` (never hidden).
    const lateOrder = await Order.create({
      buyerTelegramId: str(lateSeller.telegramId),
      shopId: world.shops[1]._id,
      orderingSessionId: sid,
      status: 'new',
      orderNumber: ++syntheticOrderNumber,
      buyerSnapshot: {
        shopId: world.shops[1]._id,
        shopName: world.shops[1].name,
        shopCity: '',
        shopAddress: world.shops[1].address,
        deliveryGroupId: str(world.group._id),
      },
      items: [
        { productId: world.products[0]._id, name: world.products[0].name, price: world.products[0].price, quantity: 1, packed: false, cancelled: false, skipped: false },
        { productId: world.products[1]._id, name: world.products[1].name, price: world.products[1].price, quantity: 1, packed: false, cancelled: false, skipped: false },
      ],
      totalPrice: Number(world.products[0].price) + Number(world.products[1].price),
      history: [{ action: 'live_e2e_late_order' }],
    });
    world.orderIds.add(str(lateOrder._id));
    await updateWorldManifest(world, { phase: 'late_order_injected' });

    const reconciled = await reconcileLateOrderStrict(lateOrder._id);
    eq(reconciled.appended, 1, 'late_order: item with still-pending task rides along');
    eq(reconciled.skipped, 1, 'late_order: unreachable late item is terminal skipped');

    const productTask = await PickingTask.findOne({ orderingSessionId: sid, productId: world.products[0]._id, status: 'pending' }).lean();
    eq(productTask.items.length, 2, 'late_order: pending task now contains on-time + late shop');
    const lateAfter = await Order.findById(lateOrder._id).lean();
    const skipped = lateAfter.items.find((i) => str(i.productId) === str(world.products[1]._id));
    check(skipped?.skipped === true && skipped?.packed === false && skipped?.cancelled === false, 'late_order: missed item is explicit skipped, never invisible');

    await claimTask(wh, productTask._id);
    await completeTask(wh, productTask._id, productTask.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await assertSessionCompleted(sid, 'late_order');
    const lateDone = await Order.findById(lateOrder._id).lean();
    eq(lateDone.status, 'fulfilled', 'late_order: delivered + skipped late Order reaches terminal fulfilled');
    check(lateDone.items.every(terminalItem), 'late_order: every late Order position has a terminal outcome');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioRecovery() {
  const world = await createWorld('recovery', { shops: 1, sellers: 1, warehouse: 1, products: 1 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 2 }], 'crash');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'recovery: picking starts');
    const task = (await getPendingTasks(world, order.orderingSessionId))[0];
    await claimTask(wh, task._id);

    // Simulate the exact crash window: OOS phase-1 committed (task says why),
    // process dies before archiveProduct phase-2. Order position intentionally
    // remains live so recovery must make it terminal.
    await PickingTask.updateOne({ _id: task._id }, {
      $set: {
        status: 'completed', completionReason: 'out_of_stock', lockedBy: null, lockedAt: null,
        completedBy: str(wh.telegramId), completedByName: wh.firstName,
        completedExpireAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
        'items.$[].packed': false, 'items.$[].packedQuantity': 0,
      },
    });
    eq((await Product.findById(world.products[0]._id).lean()).status, 'active', 'recovery: simulated crash leaves product active before sweep');

    const sweep = await archiveOrphanedOutOfStockProducts(str(world.group._id), str(order.orderingSessionId));
    eq(sweep.fixedCount, 1, 'recovery: orphan OOS sweep repairs one product');
    eq((await Product.findById(world.products[0]._id).lean()).status, 'archived', 'recovery: product archived after sweep');
    const repairedOrder = await Order.findById(order._id).lean();
    check(repairedOrder.items[0].cancelled === true, 'recovery: live Order item cancelled by recovered archive');
    eq(repairedOrder.status, 'cancelled', 'recovery: Order gets terminal cancelled status');
    await assertSessionCompleted(order.orderingSessionId, 'recovery');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioHiddenItem() {
  const world = await createWorld('hidden_item', { shops: 1, sellers: 1, warehouse: 1, products: 2 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 1 }], 'visible');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'hidden_item: picking starts with clean coverage');
    const task = (await getPendingTasks(world, order.orderingSessionId))[0];
    await claimTask(wh, task._id);

    // Inject a live position AFTER the plan was built, with no corresponding task.
    // This emulates the exact "order somehow landed in session but warehouse cannot
    // see it" integrity failure we want the closure audit to catch.
    await Order.updateOne({ _id: order._id }, {
      $push: { items: {
        productId: world.products[1]._id, name: world.products[1].name, price: world.products[1].price,
        quantity: 1, packed: false, cancelled: false, skipped: false,
      } },
      $inc: { totalPrice: world.products[1].price },
    });

    const done = await completeTask(wh, task._id, task.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    const blockerCodes = (done.closureBlockers || []).map((b) => b.code);
    includes(blockerCodes, 'coverage_gaps', 'hidden_item: completion response exposes coverage gap');
    includes(blockerCodes, 'unterminated_items', 'hidden_item: completion response exposes unterminated Order item');
    eq((await OrderingSession.findById(order.orderingSessionId).lean()).pickingStatus, 'in_progress', 'hidden_item: session correctly refuses to complete');

    const closureHttp = await api('GET', `/api/picking/session-closure?deliveryGroupId=${encodeURIComponent(str(world.group._id))}`, wh);
    eq(closureHttp.status, 200, 'hidden_item: read-only closure diagnostics endpoint works');
    check(closureHttp.data?.ok === false, 'hidden_item: diagnostics says closure blocked');

    const repair = await api('POST', '/api/picking/resolve-coverage-gap', wh, {
      deliveryGroupId: str(world.group._id), productId: str(world.products[1]._id),
    });
    check(repair.status === 200 && repair.data?.resolved === true, 'hidden_item: coverage repair resolves invisible position');
    await assertSessionCompleted(order.orderingSessionId, 'hidden_item');
    const finalOrder = await Order.findById(order._id).lean();
    check(finalOrder.items.every(terminalItem), 'hidden_item: every Order item ends terminal after repair');
    return world;
  } catch (e) { e.world = world; throw e; }
}

async function scenarioGroupMismatch() {
  const world = await createWorld('group_mismatch', { shops: 1, sellers: 1, warehouse: 1, products: 1 });
  try {
    const seller = world.sellers[0];
    const wh = world.warehouses[0];
    const order = await placeOrder(world, seller, [{ product: world.products[0], quantity: 1 }], 'mismatch');
    await moveWorldToClosedPhase(world);
    const start = await startPicking(world, wh, true);
    check(start.data?.started === true, 'group_mismatch: picking starts');
    const task = (await getPendingTasks(world, order.orderingSessionId))[0];
    const wrongIdentity = await auditSessionClosure({
      deliveryGroupId: new mongoose.Types.ObjectId().toString(),
      orderingSessionId: str(order.orderingSessionId),
    });
    includes(wrongIdentity.blockers.map((b) => b.code), 'session_identity_invalid', 'group_mismatch: wrong session/group identity is an explicit blocker');

    const originalGroupId = task.deliveryGroupId;
    await PickingTask.updateOne({ _id: task._id }, { $set: { deliveryGroupId: new mongoose.Types.ObjectId().toString() } });

    const closure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(order.orderingSessionId) });
    check(!closure.ok, 'group_mismatch: corrupted session-owned task blocks only its own session');
    includes(closure.blockers.map((b) => b.code), 'session_task_group_mismatch', 'group_mismatch: blocker is visible, not silent');

    await PickingTask.updateOne({ _id: task._id }, { $set: { deliveryGroupId: originalGroupId } });

    const originalOrderGroupId = str((await Order.findById(order._id).lean()).buyerSnapshot?.deliveryGroupId);
    await Order.updateOne({ _id: order._id }, { $set: { 'buyerSnapshot.deliveryGroupId': new mongoose.Types.ObjectId().toString() } });
    const orderMismatch = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(order.orderingSessionId) });
    check(!orderMismatch.ok, 'group_mismatch: corrupted session-owned Order blocks only its own session');
    includes(orderMismatch.blockers.map((b) => b.code), 'session_order_group_mismatch', 'group_mismatch: Order group mismatch is visible, not silent');
    await Order.updateOne({ _id: order._id }, { $set: { 'buyerSnapshot.deliveryGroupId': originalOrderGroupId } });

    await claimTask(wh, task._id);
    const fresh = await PickingTask.findById(task._id).lean();
    await completeTask(wh, task._id, fresh.items.map((i) => ({ orderId: str(i.orderId), actualQty: i.quantity })));
    await assertSessionCompleted(order.orderingSessionId, 'group_mismatch');
    return world;
  } catch (e) { e.world = world; throw e; }
}

const SCENARIOS = [
  ['happy', scenarioHappy],
  ['remove_last', scenarioRemoveLast],
  ['conflict_move', scenarioConflictMove],
  ['conflict_relocate', scenarioConflictRelocate],
  ['conflict_unassign', scenarioConflictUnassign],
  ['coverage', scenarioCoverage],
  ['isolation', scenarioIsolation],
  ['barrier', scenarioBarrier],
  ['short_pick', scenarioShortPick],
  ['oos', scenarioOOS],
  ['late_order', scenarioLateOrder],
  ['recovery', scenarioRecovery],
  ['hidden_item', scenarioHiddenItem],
  ['group_mismatch', scenarioGroupMismatch],
];

async function runScenario(name, fn) {
  if (!selected(name)) return;
  section(`SCENARIO: ${name}`);
  const started = nowMs();
  let world = null;
  try {
    world = await fn();
    scenarioResults.push({ name, ok: true, durationMs: nowMs() - started });
    pass(`${name}: SCENARIO PASS`, `${nowMs() - started} ms`);
  } catch (err) {
    world = err.world || world;
    scenarioResults.push({ name, ok: false, durationMs: nowMs() - started, error: err.message, assertionName: err.assertionName || null });
    console.error(`\n  💥 ${name}: ${err.stack || err.message}`);
    if (keepOnFailure && world) {
      preservedWorlds.push(world);
      await updateWorldManifest(world, { phase: 'failed_preserved', failed: true });
      console.error(`  ⚠️ Fixtures preserved by --keep-on-failure. marker=${MARKER} groupId=${str(world.group?._id)}`);
      return;
    }
  } finally {
    if (world && !(keepOnFailure && scenarioResults[scenarioResults.length - 1]?.name === name && scenarioResults[scenarioResults.length - 1]?.ok === false)) {
      try {
        await cleanupWorld(world);
        const clean = await verifyWorldClean(world);
        if (!clean) {
          assertions.push({ ok: false, name: `${name}: cleanup`, details: 'leftovers detected' });
          const row = scenarioResults.find((r) => r.name === name);
          if (row) { row.ok = false; row.cleanupFailed = true; }
          console.error(`  ❌ ${name}: cleanup left test data behind`);
        } else {
          await markWorldCleaned(world);
          console.log(`  🧹 ${name}: cleanup OK`);
        }
      } catch (cleanupErr) {
        const row = scenarioResults.find((r) => r.name === name);
        if (row) { row.ok = false; row.cleanupFailed = true; row.cleanupError = cleanupErr.message; }
        assertions.push({ ok: false, name: `${name}: cleanup`, details: cleanupErr.message });
        console.error(`  ❌ ${name}: cleanup error: ${cleanupErr.stack || cleanupErr.message}`);
      }
    }
  }
}

async function preflight() {
  section('LIVE E2E PREFLIGHT');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  pass('MongoDB connection', `db=${mongoose.connection.db.databaseName} host=${mongoose.connection.host} allowed=${allowedSuffix()}`);

  const scheduleDoc = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  check(Boolean(scheduleDoc?.value), 'ordering.schedule exists in live DB');
  const schedule = await getOrderingSchedule();
  pass('ordering.schedule loaded', `${String(schedule.openHour).padStart(2, '0')}:${String(schedule.openMinute).padStart(2, '0')} → ${String(schedule.closeHour).padStart(2, '0')}:${String(schedule.closeMinute).padStart(2, '0')}`);

  const openDay = findOpenDeliveryDay(schedule);
  const closedDay = findClosedDeliveryDay(schedule);
  check(openDay != null, 'At least one synthetic delivery day is currently in ordering-open phase', `day=${openDay}`);
  check(closedDay != null, 'At least one synthetic delivery day is currently in picking-allowed phase', `day=${closedDay}`);

  const [orderIndexes, taskIndexes, sessionIndexes, blockIndexes] = await Promise.all([
    Order.collection.indexes(), PickingTask.collection.indexes(), OrderingSession.collection.indexes(), Block.collection.indexes(),
  ]);
  includes(orderIndexes.map((i) => i.name), 'one_active_order_per_buyer_shop_session', 'Critical Order active uniqueness index exists');
  includes(taskIndexes.map((i) => i.name), 'one_active_task_per_product_group_session', 'Critical PickingTask session-scoped uniqueness index exists');
  check(sessionIndexes.some((i) => i.unique && i.key?.groupId === 1 && i.key?.openDate === 1), 'OrderingSession groupId+openDate unique index exists');
  const blockIndex = blockIndexes.find((i) => i.name === 'one_product_per_nonempty_block');
  check(Boolean(blockIndex?.unique && blockIndex?.partialFilterExpression), 'Critical Block partial unique index exists');

  // Confirm Atlas transactions work without touching any business document.
  const s = await mongoose.connection.startSession();
  try {
    await s.withTransaction(async () => {
      await mongoose.connection.db.collection('counters').findOne({ name: '__live_e2e_transaction_probe__' }, { session: s });
    });
    pass('MongoDB transaction round-trip');
  } finally { s.endSession(); }

  const collisions = await Promise.all([
    DeliveryGroup.countDocuments({ name: { $regex: '^__LIVE_E2E__' } }),
    Shop.countDocuments({ name: { $regex: '^__LIVE_E2E__' } }),
    Product.countDocuments({ source: 'live_e2e' }),
    User.countDocuments({ lastName: /^\d{14}-[0-9a-f]{6}$/ }),
  ]);
  const existingTestRows = collisions.reduce((a, b) => a + b, 0);
  if (existingTestRows) {
    console.warn(`  ⚠️ Found ${existingTestRows} older __LIVE_E2E__/live_e2e rows. This run will NOT delete them automatically.`);
    console.warn('     They are not production customers, but clean them by their old run id before final launch if needed.');
  } else pass('No previous LIVE_E2E fixture leftovers detected');

  check(!hadRedis || !process.env.REDIS_URL, 'Live Redis is isolated from this suite', hadRedis ? 'REDIS_URL existed but is disabled in test process' : 'no REDIS_URL');
}

async function startLocalApp() {
  // Require only after Counter patch + test-process env isolation are in place.
  const app = require('../app');
  localServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', resolve);
  });
  const address = localServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  check(health?.status === 'ok', 'Ephemeral real Express app is writable', `status=${health?.status}`);
}

function writeReport() {
  const passedAssertions = assertions.filter((a) => a.ok).length;
  const failedAssertions = assertions.filter((a) => !a.ok).length;
  const passedScenarios = scenarioResults.filter((s) => s.ok).length;
  const failedScenarios = scenarioResults.filter((s) => !s.ok).length;
  const report = {
    runId: RUN_ID,
    marker: MARKER,
    createdAt: new Date().toISOString(),
    db: mongoose.connection?.db?.databaseName || null,
    redisWasConfiguredButIsolated: hadRedis,
    execute,
    requestedScenarios: requestedScenarios ? [...requestedScenarios] : 'all',
    summary: { passedScenarios, failedScenarios, passedAssertions, failedAssertions },
    scenarios: scenarioResults,
    assertions,
    preserved: preservedWorlds.map((w) => ({ name: w.name, groupId: str(w.group?._id), marker: MARKER })),
  };
  const jsonPath = path.join(REPORT_DIR, `live-e2e-${RUN_ID}.json`);
  const mdPath = path.join(REPORT_DIR, `live-e2e-${RUN_ID}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const md = [
    `# LIVE E2E ${RUN_ID}`,
    '',
    `- Scenarios: **${passedScenarios} passed / ${failedScenarios} failed**`,
    `- Assertions: **${passedAssertions} passed / ${failedAssertions} failed**`,
    `- Live DB: \`${report.db || 'unknown'}\``,
    `- Redis: ${hadRedis ? 'configured in environment, intentionally isolated for this DB suite' : 'not configured'}`,
    '',
    '## Scenarios',
    ...scenarioResults.map((s) => `- ${s.ok ? '✅' : '❌'} **${s.name}** — ${s.durationMs} ms${s.error ? ` — ${s.error}` : ''}`),
    '',
    '## Failed assertions',
    ...(assertions.filter((a) => !a.ok).length
      ? assertions.filter((a) => !a.ok).map((a) => `- ❌ ${a.name}${a.details ? ` — ${a.details}` : ''}`)
      : ['- none']),
    '',
    '## Safety',
    `All test fixtures are prefixed/tagged with \`${MARKER}\`. Real sellers, shops, groups and products are never selected as fixtures.`,
  ].join('\n');
  fs.writeFileSync(mdPath, md);
  return { jsonPath, mdPath, report };
}

async function main() {
  let reportInfo = null;
  try {
    await preflight();
    if (!execute) {
      section('PREFLIGHT ONLY');
      log('Нічого не створено. Для реального live E2E запусти:');
      log('  node scripts/liveOrderPickingE2E.js --execute');
      return;
    }

    await initRunManifest();
    section('RUN SAFETY');
    log(`RUN_ID: ${RUN_ID}`);
    log(`Marker: ${MARKER}`);
    log('Якщо процес/SSH впаде, cleanup ТІЛЬКИ цього прогону:');
    log(`  node scripts/liveOrderPickingE2ECleanup.js --runId=${RUN_ID} --execute`);

    await startLocalApp();
    for (const [name, fn] of SCENARIOS) await runScenario(name, fn);
  } finally {
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
    try {
      const cleanupBroken = assertions.some((a) => !a.ok && a.name.endsWith(': cleanup'));
      if (manifestValue) await finishRunManifest({ preserve: preservedWorlds.length > 0 || cleanupBroken });
    } catch (e) {
      console.error(`Manifest finalize failed: ${e.message}`);
      assertions.push({ ok: false, name: 'run manifest cleanup', details: e.message });
    }
    try { reportInfo = writeReport(); } catch (e) { console.error('Report write failed:', e.message); }
    try { await mongoose.connection.close(false); } catch { /* noop */ }
  }

  section('LIVE E2E RESULT');
  const failed = scenarioResults.filter((s) => !s.ok);
  const cleanupFailures = assertions.filter((a) => !a.ok && (a.name.endsWith(': cleanup') || a.name === 'run manifest cleanup'));
  log(`Results: ${scenarioResults.length - failed.length} passed ${failed.length} failed`);
  log(`Assertions: ${assertions.filter((a) => a.ok).length} passed ${assertions.filter((a) => !a.ok).length} failed`);
  if (reportInfo) {
    log(`Report JSON: ${reportInfo.jsonPath}`);
    log(`Report MD:   ${reportInfo.mdPath}`);
  }
  if (preservedWorlds.length) {
    log('\n⚠️ Preserved failed fixtures:');
    for (const w of preservedWorlds) log(`  ${w.name}: groupId=${str(w.group?._id)} marker=${MARKER}`);
    log(`Cleanup exact run: node scripts/liveOrderPickingE2ECleanup.js --runId=${RUN_ID} --execute`);
  }
  if (failed.length || cleanupFailures.length || assertions.some((a) => !a.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n💥 LIVE E2E fatal error:', err.stack || err.message);
  try { writeReport(); } catch { /* noop */ }
  process.exitCode = 1;
});
