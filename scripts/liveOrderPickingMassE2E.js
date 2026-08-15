'use strict';

/**
 * MASS LIVE MongoDB E2E — realistic intertwined warehouse shift.
 *
 * This is deliberately NOT a micro-test. Default world:
 *   100 ordering sellers + 8 late sellers
 *   120 shops
 *   240 products in 12 physical blocks
 *   12 concurrent warehouse workers
 *   20 products/order (+ concurrent merge bursts)
 *   10 conflict shops with 3 active buyers each before picking start
 *   old-session stale Orders + orphan PickingTasks
 *   hot products ordered by almost every shop
 *   concurrent claim race, progress/complete race
 *   whole OOS blocks, partial OOS, short-pick, late-order reconcile
 *   hidden OrderItem + wrong-group task/order blockers, then repair
 *
 * All fixtures are synthetic and exact-run-owned. The script refuses to run on
 * any Mongo host except LIVE_E2E_ALLOWED_DB_HOST (default epfky0s.mongodb.net).
 * Redis is disabled in THIS process so no shared production/test cache namespace
 * is mutated; Mongo indexes/transactions are real.
 *
 * Dry preflight:
 *   npm run test:live:e2e:mass:preflight
 * Execute:
 *   npm run test:live:e2e:mass
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
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
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI не заданий.');
  process.exit(2);
}
const {
  assertEnvUriAllowed,
  assertConnectedHostAllowed,
  allowedSuffix,
} = require('../utils/liveE2EDbGuard');
try { assertEnvUriAllowed(process.env.MONGODB_URI); }
catch (err) { console.error(`⛔ ${err.message}`); process.exit(3); }

const hadRedis = Boolean(process.env.REDIS_URL);
delete process.env.REDIS_URL;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
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
const { isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { buildOpenClosedTestSchedules } = require('./helpers/perGroupTestSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { signSession } = require('../utils/jwt');
const { auditSessionClosure } = require('../services/sessionClosure');
const { reconcileLateOrderStrict } = require('../services/lateOrderReconcile');
const { archiveOrphanedOutOfStockProducts } = require('../services/pickingService');
const {
  fetchWithTimeout,
  createProgressWatchdog,
  assertNoActiveGlobalHarnessLease,
  acquireGlobalHarnessLease,
  waitForStableZero,
  fingerprintCollections,
  compareFingerprints,
  parseIntArg,
} = require('./helpers/liveHarnessSafety');

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function parseReplayConfig(argv) {
  const rawArg = argv.find((arg) => arg.startsWith('--cfg='));
  if (!rawArg) return null;
  try {
    const decoded = Buffer.from(rawArg.slice('--cfg='.length), 'base64url').toString('utf8');
    const value = JSON.parse(decoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object');
    return value;
  } catch (err) {
    throw new Error(`Invalid --cfg replay token: ${err.message}`);
  }
}
const REPLAY_CFG = parseReplayConfig(argv);
function intCfg(key, envName, fallback, min, max) {
  if (REPLAY_CFG && Object.prototype.hasOwnProperty.call(REPLAY_CFG, key)) {
    const n = Number(REPLAY_CFG[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid replay config ${key}=${REPLAY_CFG[key]}`);
    return n;
  }
  return intEnv(envName, fallback, min, max);
}
const CFG = {
  sellers: intCfg('sellers', 'LIVE_E2E_MASS_SELLERS', 100, 20, 300),
  lateSellers: intCfg('lateSellers', 'LIVE_E2E_MASS_LATE_SELLERS', 8, 0, 30),
  shops: intCfg('shops', 'LIVE_E2E_MASS_SHOPS', 120, 40, 400),
  products: intCfg('products', 'LIVE_E2E_MASS_PRODUCTS', 240, 40, 600),
  blocks: intCfg('blocks', 'LIVE_E2E_MASS_BLOCKS', 12, 2, 30),
  warehouses: intCfg('warehouses', 'LIVE_E2E_MASS_WAREHOUSE', 12, 2, 30),
  itemsPerOrder: intCfg('itemsPerOrder', 'LIVE_E2E_MASS_ITEMS_PER_ORDER', 20, 5, 50),
  orderConcurrency: intCfg('orderConcurrency', 'LIVE_E2E_MASS_ORDER_CONCURRENCY', 100, 2, 150),
  mergeRaceSellers: intCfg('mergeRaceSellers', 'LIVE_E2E_MASS_MERGE_RACE_SELLERS', 25, 1, 80),
  conflictShops: intCfg('conflictShops', 'LIVE_E2E_MASS_CONFLICT_SHOPS', 10, 1, 20),
  oosBlocks: intCfg('oosBlocks', 'LIVE_E2E_MASS_OOS_BLOCKS', 2, 1, 4),
};
if (CFG.sellers < 80 || CFG.shops < CFG.sellers || CFG.products < CFG.blocks * 2) {
  console.error('❌ Mass config занадто малий/несумісний для realistic scenario.', CFG);
  process.exit(2);
}
if (CFG.conflictShops * 2 > CFG.sellers - 80) CFG.conflictShops = Math.max(1, Math.floor((CFG.sellers - 80) / 2));
if (80 + CFG.conflictShops * 2 > CFG.sellers) CFG.conflictShops = Math.floor((CFG.sellers - 80) / 2);

const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const MARKER = `__LIVE_E2E_MASS__${RUN_ID}`;
const MANIFEST_KEY = `live-e2e.run.${RUN_ID}`;
const REPORT_DIR = path.resolve(__dirname, '../test-reports');
fs.mkdirSync(REPORT_DIR, { recursive: true });

let syntheticOrderNumber = 960_000_000 + crypto.randomInt(0, 20_000_000);
const originalCounterFindOneAndUpdate = Counter.findOneAndUpdate.bind(Counter);
Counter.findOneAndUpdate = function massCounterIsolation(filter, update, options) {
  if (filter && filter.name === 'orderNumber') {
    syntheticOrderNumber += 1;
    return Promise.resolve({ name: 'orderNumber', seq: syntheticOrderNumber });
  }
  return originalCounterFindOneAndUpdate(filter, update, options);
};

const world = {
  name: 'mass_mesh', group: null, shops: [], sellers: [], lateSellers: [], warehouses: [], users: [],
  products: [], blocks: [], sessionIds: new Set(), orderIds: new Set(), oldSessionId: null, poisonSeller: null,
};
let manifest = null;
let server = null;
let baseUrl = '';
let globalLease = null;
let watchdog = null;
let baselineFingerprint = null;
const assertions = [];
const metrics = { api: {}, phases: {}, counts: {}, races: {} };
const startedAt = Date.now();

function str(v) { return v == null ? '' : String(v); }
function tid(task) {
  // Tasks returned by Mongo use `_id`; API task payloads use `taskId`.
  // Accept both so race helpers can safely consume either representation.
  return str(task?.taskId || task?._id);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function terminal(i) { return Boolean(i?.packed || i?.cancelled || i?.skipped || i?.voided); }
function log(s = '') { console.log(s); }
function section(t) { log(`\n${'═'.repeat(90)}\n${t}\n${'═'.repeat(90)}`); }
function check(cond, name, details = '') {
  watchdog?.touch('assertion', name);
  assertions.push({ ok: Boolean(cond), name, details });
  if (!cond) {
    console.error(`  ❌ ${name}${details ? ` — ${details}` : ''}`);
    const e = new Error(details || name); e.assertionName = name; throw e;
  }
  console.log(`  ✅ ${name}${details ? ` — ${details}` : ''}`);
}
function eq(a, b, name) { check(a === b, name, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}
function recordApi(label, ms, status) {
  watchdog?.touch('http', `${label} status=${status}`);
  if (!metrics.api[label]) metrics.api[label] = { n: 0, ok: 0, fail: 0, ms: [] };
  const x = metrics.api[label]; x.n += 1; x.ms.push(ms); if (status >= 200 && status < 400) x.ok += 1; else x.fail += 1;
}
function phaseStart(name) { watchdog?.touch('phase', name); metrics.phases[name] = { startedAt: Date.now() }; }
function phaseEnd(name) { watchdog?.touch('phase-end', name); metrics.phases[name].durationMs = Date.now() - metrics.phases[name].startedAt; delete metrics.phases[name].startedAt; }

function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
const generatedSeed = Number.parseInt(crypto.createHash('sha1').update(RUN_ID).digest('hex').slice(0, 8), 16) >>> 0;
const seedNum = parseIntArg(argv, 'seed', generatedSeed, { min: 0, max: 0xFFFFFFFF }) >>> 0;
const replayCfgToken = Buffer.from(JSON.stringify(CFG), 'utf8').toString('base64url');
const replayCommand = `npm run test:live:e2e:mass -- --seed=${seedNum} --cfg=${replayCfgToken}`;
const rnd = seeded(seedNum);

function makeTelegramId(i) {
  const h = Number.parseInt(crypto.createHash('sha1').update(RUN_ID).digest('hex').slice(0, 6), 16) % 900000;
  return `-991${String(h).padStart(6, '0')}${String(i).padStart(4, '0')}`;
}

async function saveManifest(phase) {
  manifest = {
    runId: RUN_ID, marker: MARKER, phase, updatedAt: new Date().toISOString(),
    worlds: {
      mass_mesh: {
        scenario: 'mass_mesh',
        groupId: str(world.group?._id),
        shopIds: world.shops.map((x) => str(x._id)),
        userTelegramIds: world.users.map((x) => str(x.telegramId)),
        productIds: world.products.map((x) => str(x._id)),
        blockMongoIds: world.blocks.map((x) => str(x._id)),
        blockMongoId: str(world.blocks[0]?._id),
        sessionIds: [...world.sessionIds].map(str),
        orderIds: [...world.orderIds].map(str),
      },
    },
  };
  await AppSetting.findOneAndUpdate({ key: MANIFEST_KEY }, { $set: { value: manifest } }, { upsert: true, new: true });
}

async function allocProductOrderNumbers(n) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = 700_000_000 + crypto.randomInt(0, 100_000_000 - n - 1);
    const nums = Array.from({ length: n }, (_, i) => base + i);
    if (!(await Product.exists({ orderNumber: { $in: nums } }))) return nums;
  }
  throw new Error('Cannot allocate synthetic Product.orderNumber range');
}
async function allocBlockIds(n) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = 700_000_000 + crypto.randomInt(0, 100_000_000 - n - 1);
    const ids = Array.from({ length: n }, (_, i) => base + i);
    if (!(await Block.exists({ blockId: { $in: ids } }))) return ids;
  }
  throw new Error('Cannot allocate synthetic blockIds');
}

async function tokenFor(user) { return signSession(str(user.telegramId)); }
async function api(method, urlPath, user, body, label = `${method} ${urlPath.split('?')[0]}`) {
  const t = Date.now();
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await tokenFor(user)}`;
  const res = await fetchWithTimeout(`${baseUrl}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, {
    label,
    parentSignal: watchdog?.signal,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  recordApi(label, Date.now() - t, res.status);
  return { status: res.status, data };
}

async function batchMap(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const rows = await Promise.all(items.slice(i, i + size).map(fn));
    out.push(...rows);
  }
  return out;
}

async function sealSyntheticOrderingNotification(groupId, schedule, sessionIds = null) {
  // The live TEST server may be running its real ordering-open scheduler against
  // the same Atlas database while this local E2E process runs. Synthetic sellers
  // use fake Telegram ids; if the real notifier sees them, Telegram correctly
  // answers 403/chat-not-found and production code marks that synthetic User as
  // botBlocked. Pre-claim the synthetic session BEFORE sellers exist so external
  // schedulers can never turn harness fixtures into registration_blocked users.
  const sessionId = await getOrCreateSessionId(str(groupId), schedule);
  if (sessionIds) sessionIds.add(str(sessionId));
  await OrderingSession.updateOne(
    { _id: sessionId },
    { $set: { openNotifiedAt: new Date() } },
  );
  return sessionId;
}

async function createWorld() {
  phaseStart('fixtures');
  const { deliveryDay, openSchedule, closedSchedule } = buildOpenClosedTestSchedules();
  world.schedule = openSchedule;
  world.closedSchedule = closedSchedule;
  check(isOrderingOpen(openSchedule).isOpen, 'Mass: synthetic per-group ordering window is open');

  world.group = await DeliveryGroup.create({
    name: `${MARKER}:group`,
    dayOfWeek: deliveryDay,
    orderingSchedule: openSchedule,
    members: [],
  });
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  await sealSyntheticOrderingNotification(world.group._id, openSchedule, world.sessionIds);

  const shopDocs = Array.from({ length: CFG.shops }, (_, i) => ({
    name: `${MARKER}:shop:${String(i + 1).padStart(3, '0')}`,
    address: `MASS TEST ${i + 1}`,
    deliveryGroupId: str(world.group._id), isActive: true,
  }));
  world.shops = await Shop.insertMany(shopDocs);

  // 0..79 = unique primary shops. Remaining ordering sellers are distributed as
  // two extra buyers per conflict shop, so 10 shops contain THREE active Orders.
  const users = [];
  for (let i = 0; i < CFG.sellers; i += 1) {
    let shopIndex;
    if (i < 80) shopIndex = i;
    else {
      const offset = i - 80;
      shopIndex = 70 + Math.floor(offset / 2);
      if (shopIndex >= 70 + CFG.conflictShops) shopIndex = 80 + (offset - CFG.conflictShops * 2);
    }
    shopIndex = Math.min(shopIndex, world.shops.length - 1);
    users.push({ telegramId: makeTelegramId(i + 1), role: 'seller', firstName: `MASS_S${i + 1}`, lastName: RUN_ID, shopId: world.shops[shopIndex]._id });
  }
  // Late synthetic sellers have no Order before picking start.
  for (let i = 0; i < CFG.lateSellers; i += 1) {
    const shopIndex = Math.min(100 + i, world.shops.length - 1);
    users.push({ telegramId: makeTelegramId(1001 + i), role: 'seller', firstName: `MASS_LATE${i + 1}`, lastName: RUN_ID, shopId: world.shops[shopIndex]._id });
  }
  // Dedicated poison seller exists only for the deliberate wrong-group Order;
  // it has no normal/late Order, so the active-order unique index is not bypassed.
  users.push({
    telegramId: makeTelegramId(1501), role: 'seller', firstName: 'MASS_POISON', lastName: RUN_ID,
    shopId: world.shops[Math.min(110, world.shops.length - 1)]._id,
  });
  for (let i = 0; i < CFG.warehouses; i += 1) {
    users.push({ telegramId: makeTelegramId(2001 + i), role: 'warehouse', firstName: `MASS_W${i + 1}`, lastName: RUN_ID });
  }
  world.users = await User.insertMany(users);
  const sellerUsers = world.users.filter((u) => u.role === 'seller');
  world.sellers = sellerUsers.slice(0, CFG.sellers);
  world.lateSellers = sellerUsers.slice(CFG.sellers, CFG.sellers + CFG.lateSellers);
  world.poisonSeller = sellerUsers[CFG.sellers + CFG.lateSellers];
  world.warehouses = world.users.filter((u) => u.role === 'warehouse');

  const orderNumbers = await allocProductOrderNumbers(CFG.products);
  world.products = await Product.insertMany(Array.from({ length: CFG.products }, (_, i) => ({
    orderNumber: orderNumbers[i], price: Number((1 + (i % 23) * 0.37).toFixed(2)), quantity: 99999,
    name: `${MARKER}:product:${String(i + 1).padStart(3, '0')}`,
    brand: `${MARKER}:P${i + 1}`, status: 'active', source: 'live_e2e_mass',
  })));

  const blockIds = await allocBlockIds(CFG.blocks);
  const per = Math.ceil(world.products.length / CFG.blocks);
  for (let b = 0; b < CFG.blocks; b += 1) {
    const ids = world.products.slice(b * per, Math.min((b + 1) * per, world.products.length)).map((p) => p._id);
    if (!ids.length) break;
    world.blocks.push(await Block.create({ blockId: blockIds[b], productIds: ids, version: 1 }));
  }

  // The live product route accepts only products that were already on a shelf
  // when the ordering cycle opened. MASS fixtures are synthetic and are built
  // after opening their synthetic window, so backdate only their placement
  // marker to model a real pre-existing shelf product.
  const availableBeforeOpen = new Date(getOrderingWindowOpenAt(openSchedule).getTime() - 60_000);
  await Product.updateMany(
    { _id: { $in: world.products.map((p) => p._id) } },
    { $set: { firstBlockPlacedAt: availableBeforeOpen } },
  );

  await saveManifest('fixtures_ready');
  phaseEnd('fixtures');
}

function orderItemsForSeller(sellerIndex) {
  const ids = new Set([0, 1]); // two hot products in every Order
  for (let k = 0; k < 3; k += 1) ids.add((sellerIndex * 3 + k) % CFG.products); // guarantees full catalog coverage
  while (ids.size < CFG.itemsPerOrder) ids.add(Math.floor(rnd() * CFG.products));
  return [...ids].map((pid) => ({ product: world.products[pid], quantity: 1 + ((sellerIndex + pid) % 5) }));
}

async function postOrder(seller, items, idem) {
  const r = await api('POST', '/api/v1/orders', seller, {
    buyerTelegramId: str(seller.telegramId),
    items: items.map((x) => ({ productId: str(x.product._id), quantity: x.quantity })),
    idempotencyKey: `${MARKER}:${idem}`,
  }, 'POST order');
  check([200, 201].includes(r.status), 'Mass order request accepted', `seller=${seller.firstName} status=${r.status} err=${r.data?.error || ''}`);
  if (r.data?._id) world.orderIds.add(str(r.data._id));
  if (r.data?.orderingSessionId) world.sessionIds.add(str(r.data.orderingSessionId));
  return r.data;
}

async function createOldSessionNoise(currentSessionId) {
  const old = await OrderingSession.create({
    groupId: str(world.group._id), openDate: '2001-01-01', openAt: new Date('2001-01-01T00:00:00Z'),
    pickingStatus: 'in_progress', pickingConfirmedAt: new Date(), pickingStartedAt: new Date(),
  });
  world.oldSessionId = str(old._id); world.sessionIds.add(str(old._id));
  for (let i = 0; i < 5; i += 1) {
    const seller = world.sellers[i]; const shop = world.shops[i]; const product = world.products[i + 10];
    const o = await Order.create({
      buyerTelegramId: str(seller.telegramId), shopId: shop._id, orderingSessionId: str(old._id), status: 'new',
      orderNumber: ++syntheticOrderNumber,
      buyerSnapshot: { shopId: shop._id, shopName: shop.name, shopCity: '', shopAddress: shop.address, deliveryGroupId: str(world.group._id) },
      items: [{ productId: product._id, name: product.name, price: product.price, quantity: 1, packed: false, cancelled: false, skipped: false }],
      totalPrice: product.price, history: [{ action: 'mass_old_noise' }],
    });
    world.orderIds.add(str(o._id));
    const b = world.blocks.find((row) => row.productIds.some((id) => str(id) === str(product._id)));
    const pos = b.productIds.findIndex((id) => str(id) === str(product._id));
    await PickingTask.create({
      productId: product._id, deliveryGroupId: str(world.group._id), orderingSessionId: str(old._id),
      blockId: b.blockId, positionIndex: pos, status: 'pending',
      items: [{ orderId: o._id, shopId: shop._id, shopName: shop.name, sellerName: seller.firstName, orderCreatedAt: o.createdAt, quantity: 1, packed: false }],
    });
  }
  await saveManifest('old_session_noise');
  check(str(currentSessionId) !== str(old._id), 'Mass old session has a distinct identity');
}

async function moveToClosedPhase(session) {
  const closedSchedule = world.closedSchedule;
  check(Boolean(closedSchedule), 'Mass: closed synthetic per-group schedule exists');
  await DeliveryGroup.updateOne(
    { _id: world.group._id },
    { $set: { orderingSchedule: closedSchedule } },
  );
  world.group.orderingSchedule = closedSchedule;
  world.schedule = closedSchedule;
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
  const resolved = await getOrCreateSessionId(str(world.group._id), closedSchedule);
  eq(str(resolved), str(session._id), 'Mass current OrderingSession identity survives open→closed phase');
  check(!isOrderingOpen(closedSchedule).isOpen, 'Mass synthetic picking phase is closed');
}

async function startPicking(wh, confirm = true) {
  return api('POST', '/api/picking/start-session', wh, { deliveryGroupId: str(world.group._id), confirm }, 'POST start-session');
}

async function createLateOrder(seller, sessionId, items, suffix, overrideGroupId = null) {
  const shop = await Shop.findById(seller.shopId).lean();
  const o = await Order.create({
    buyerTelegramId: str(seller.telegramId), shopId: shop._id, orderingSessionId: str(sessionId), status: 'new',
    orderNumber: ++syntheticOrderNumber,
    buyerSnapshot: {
      shopId: shop._id, shopName: shop.name, shopCity: '', shopAddress: shop.address,
      deliveryGroupId: overrideGroupId == null ? str(world.group._id) : String(overrideGroupId),
    },
    items: items.map(({ product, quantity }) => ({
      productId: product._id, name: product.name, price: product.price, quantity,
      packed: false, cancelled: false, skipped: false,
    })),
    totalPrice: items.reduce((s, x) => s + x.product.price * x.quantity, 0),
    history: [{ action: `mass_late_${suffix}` }],
  });
  world.orderIds.add(str(o._id)); await saveManifest('late_orders'); return o;
}

async function claimRace(task) {
  section('RACE: 12 workers claim same task');
  const results = await Promise.all(world.warehouses.map((wh) => api('POST', `/api/picking/tasks/${tid(task)}/claim`, wh, {}, 'POST claim-race')));
  const wins = results.map((r, i) => ({ ...r, i })).filter((r) => r.status === 200 && r.data?.task);
  eq(wins.length, 1, 'Exactly one warehouse worker wins an atomic claim race');
  check(results.every((r) => r.status === 200 || r.status === 409),
    'Claim-race losers fail only with expected conflict status',
    `statuses=${results.map((r) => r.status).join(',')}`);
  metrics.races.claim = results.map((r) => r.status);
  return { wh: world.warehouses[wins[0].i], task: wins[0].data.task };
}

async function fullComplete(wh, task) {
  return api('POST', `/api/picking/tasks/${tid(task)}/complete`, wh, {
    items: (task.items || []).map((i) => ({ orderId: str(i.orderId), actualQty: Number(i.quantity) || 0 })),
  }, 'POST complete');
}

async function progressCompleteRace(wh, task) {
  section('RACE: progress PATCH vs complete');
  const half = (task.items || []).slice(0, Math.ceil((task.items || []).length / 2)).map((i) => str(i.orderId));
  const [progress, done] = await Promise.all([
    api('PATCH', `/api/picking/tasks/${tid(task)}/progress`, wh, { packedOrderIds: half }, 'PATCH progress-race'),
    fullComplete(wh, task),
  ]);
  check([progress.status, done.status].every((status) => [200, 403, 409].includes(status)),
    'Progress/complete race returns only expected success/conflict statuses',
    `progress=${progress.status} complete=${done.status}`);
  check(done.status === 200 || progress.status === 200, 'At least one progress/complete contender succeeds');
  const final = await PickingTask.findById(tid(task)).lean();
  eq(final.status, 'completed', 'Progress/complete race leaves one terminal completed task');
  metrics.races.progressComplete = { progress: progress.status, complete: done.status };
}

async function processTask(wh, task, oosProductIds, shortProductIds, progressProductIds) {
  const pid = str(task.productId?._id || task.productId);
  if (progressProductIds.has(pid) && (task.items || []).length > 1) {
    const packed = task.items.slice(0, Math.floor(task.items.length / 2)).map((i) => str(i.orderId));
    const p = await api('PATCH', `/api/picking/tasks/${tid(task)}/progress`, wh, { packedOrderIds: packed }, 'PATCH progress');
    check(p.status === 200, 'Mass partial progress save succeeds', `task=${tid(task)}`);
    const hb = await api('POST', `/api/picking/tasks/${tid(task)}/heartbeat`, wh, {}, 'POST heartbeat');
    check(hb.status === 200, 'Mass heartbeat succeeds after progress');
  }

  if (oosProductIds.has(pid)) {
    const items = task.items || [];
    const packedOrderIds = items.filter((_, idx) => idx % 2 === 0).map((i) => str(i.orderId));
    return api('POST', `/api/picking/tasks/${tid(task)}/out-of-stock`, wh, { packedOrderIds }, 'POST OOS');
  }

  const payload = (task.items || []).map((i, idx) => {
    let actual = Number(i.quantity) || 0;
    if (shortProductIds.has(pid) && idx === 0 && actual > 1) actual -= 1;
    return { orderId: str(i.orderId), actualQty: actual };
  });
  return api('POST', `/api/picking/tasks/${tid(task)}/complete`, wh, { items: payload }, 'POST complete');
}

async function nextTask(wh, blockId) {
  return api('POST', '/api/picking/next-task', wh, {
    currentBlock: blockId,
    deliveryGroupId: str(world.group._id),
  }, 'POST next-task');
}

async function runWorker(wh, initialBlockId, sessionId, outcomeSets, stop) {
  let blockId = initialBlockId;
  let task = null;
  let iterations = 0;
  while (!stop.value && iterations < CFG.products * 6) {
    iterations += 1;
    if (!task) {
      const n = await nextTask(wh, blockId);
      check(n.status === 200, 'Mass next-task returns clean HTTP response', `worker=${wh.firstName} status=${n.status}`);
      if (n.data?.task) task = n.data.task;
      else {
        const pending = await PickingTask.find({ orderingSessionId: str(sessionId), deliveryGroupId: str(world.group._id), status: 'pending' }, 'blockId').sort({ blockId: 1 }).limit(1).lean();
        if (!pending.length) break;
        blockId = pending[0].blockId;
        await sleep(5 + Math.floor(rnd() * 15));
        continue;
      }
    }
    const result = await processTask(wh, task, outcomeSets.oos, outcomeSets.short, outcomeSets.progress);
    check(result.status === 200, 'Mass task finalization succeeds', `worker=${wh.firstName} task=${tid(task)} status=${result.status} err=${result.data?.error || ''}`);
    if (result.data?.nextTask) {
      task = result.data.nextTask;
      blockId = task.blockId || blockId;
    } else {
      task = null;
      const pending = await PickingTask.find({ orderingSessionId: str(sessionId), deliveryGroupId: str(world.group._id), status: 'pending' }, 'blockId').sort({ blockId: 1 }).limit(1).lean();
      if (pending.length) blockId = pending[0].blockId;
    }
  }
  return iterations;
}

async function pollDuringPicking(wh, stop) {
  let n = 0; let failures = 0; let transportErrors = 0;
  while (!stop.value && n < 500) {
    try {
      const [closure, locked] = await Promise.all([
        api('GET', `/api/picking/session-closure?deliveryGroupId=${encodeURIComponent(str(world.group._id))}`, wh, undefined, 'GET closure-poll'),
        api('GET', `/api/picking/locked-tasks?deliveryGroupId=${encodeURIComponent(str(world.group._id))}`, wh, undefined, 'GET locked-poll'),
      ]);
      if (closure.status !== 200 || locked.status !== 200) failures += 1;
    } catch (err) {
      // A worker assertion may abort runMass while pollers are in-flight. Do not
      // turn that into an unhandled `fetch failed` that bypasses the harness'
      // cleanup/report path. During a normal run this is still counted and fails
      // the polling assertion below.
      if (stop.value) break;
      transportErrors += 1;
    }
    n += 1;
    if (!stop.value) await sleep(75);
  }
  return { n, failures, transportErrors };
}

async function verifyOrderInvariants(sessionId) {
  const rows = await Order.find({ orderingSessionId: str(sessionId) }).lean();
  const activeByIdentity = new Map();
  for (const o of rows.filter((x) => ['new', 'in_progress'].includes(x.status) && x.shopId)) {
    const key = `${o.buyerTelegramId}:${o.shopId}:${o.orderingSessionId}`;
    activeByIdentity.set(key, (activeByIdentity.get(key) || 0) + 1);
  }
  check([...activeByIdentity.values()].every((n) => n === 1), 'No seller/shop/session has duplicate active Orders after mass races');
  for (const o of rows) {
    const ids = (o.items || []).map((i) => str(i.productId)).filter(Boolean);
    check(new Set(ids).size === ids.length, 'No duplicate product rows inside any mass Order', `order=${o.orderNumber}`);
  }
  return rows;
}

async function cleanupPass() {
  const groupId = str(world.group?._id);
  const userIds = world.users.map((u) => str(u.telegramId));
  const productIds = world.products.map((p) => p._id);
  const shopIds = world.shops.map((s) => s._id);
  const liveSessionIds = groupId ? (await OrderingSession.find({ groupId }, '_id').lean()).map((s) => str(s._id)) : [];
  const sessionIds = [...new Set([...(world.sessionIds || []), ...liveSessionIds].map(str).filter(Boolean))];
  if (groupId || sessionIds.length || productIds.length) {
    const ors = [];
    if (groupId) ors.push({ deliveryGroupId: groupId });
    if (sessionIds.length) ors.push({ orderingSessionId: { $in: sessionIds } });
    if (productIds.length) ors.push({ productId: { $in: productIds } });
    await PickingTask.deleteMany({ $or: ors });
  }
  if (userIds.length || sessionIds.length) await Order.deleteMany({ $or: [{ buyerTelegramId: { $in: userIds } }, { orderingSessionId: { $in: sessionIds } }] });
  if (userIds.length) await ShopAuditLog.deleteMany({ $or: [{ sellerTelegramId: { $in: userIds } }, { actorTelegramId: { $in: userIds } }] });
  if (sessionIds.length) await OrderingSession.deleteMany({ _id: { $in: sessionIds } });
  if (groupId) await Counter.deleteMany({ name: `session-seq:${groupId}` });
  if (world.blocks.length) await Block.deleteMany({ _id: { $in: world.blocks.map((b) => b._id) } });
  if (productIds.length) await Product.deleteMany({ _id: { $in: productIds } });
  if (userIds.length) await User.deleteMany({ telegramId: { $in: userIds } });
  if (shopIds.length) await Shop.deleteMany({ _id: { $in: shopIds } });
  if (groupId) await DeliveryGroup.deleteOne({ _id: world.group._id });
  if (groupId) { await OrderingSession.deleteMany({ groupId }); await Counter.deleteMany({ name: `session-seq:${groupId}` }); }
  await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
}

async function cleanup() {
  await cleanupPass();
  await waitForStableZero(async () => ({ total: await leftovers() }), {
    label: 'MASS cleanup',
    quietMs: 800,
    timeoutMs: 10_000,
    intervalMs: 150,
    onNonZero: () => cleanupPass(),
  });
}

async function leftovers() {
  const groupId = str(world.group?._id);
  const userIds = world.users.map((u) => str(u.telegramId));
  const productIds = world.products.map((p) => p._id);
  const shopIds = world.shops.map((s) => s._id);
  const liveSessionIds = groupId ? (await OrderingSession.find({ groupId }, '_id').lean()).map((s) => str(s._id)) : [];
  const sessionIds = [...new Set([...(world.sessionIds || []), ...liveSessionIds].map(str).filter(Boolean))];
  const taskOr = [
    ...(groupId ? [{ deliveryGroupId: groupId }] : []),
    ...(sessionIds.length ? [{ orderingSessionId: { $in: sessionIds } }] : []),
    ...(productIds.length ? [{ productId: { $in: productIds } }] : []),
  ];
  const orderOr = [
    ...(userIds.length ? [{ buyerTelegramId: { $in: userIds } }] : []),
    ...(sessionIds.length ? [{ orderingSessionId: { $in: sessionIds } }] : []),
  ];
  const vals = await Promise.all([
    groupId ? DeliveryGroup.countDocuments({ _id: world.group._id }) : 0,
    groupId ? OrderingSession.countDocuments({ groupId }) : 0,
    taskOr.length ? PickingTask.countDocuments({ $or: taskOr }) : 0,
    orderOr.length ? Order.countDocuments({ $or: orderOr }) : 0,
    userIds.length ? User.countDocuments({ telegramId: { $in: userIds } }) : 0,
    shopIds.length ? Shop.countDocuments({ _id: { $in: shopIds } }) : 0,
    productIds.length ? Product.countDocuments({ _id: { $in: productIds } }) : 0,
    world.blocks.length ? Block.countDocuments({ _id: { $in: world.blocks.map((b) => b._id) } }) : 0,
    userIds.length ? ShopAuditLog.countDocuments({ $or: [{ sellerTelegramId: { $in: userIds } }, { actorTelegramId: { $in: userIds } }] }) : 0,
    groupId ? Counter.countDocuments({ name: `session-seq:${groupId}` }) : 0,
  ]);
  return vals.reduce((a, b) => a + Number(b || 0), 0);
}

async function preflight() {
  section('MASS LIVE E2E PREFLIGHT');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000, socketTimeoutMS: 30_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  await assertNoActiveGlobalHarnessLease({ AppSetting });
  check(true, 'No active global live-harness lease before MASS');
  log(`DB guard OK: db=${mongoose.connection.db.databaseName} host=${mongoose.connection.host} allowed=${allowedSuffix()}`);
  const synthetic = buildOpenClosedTestSchedules();
  check(isOrderingOpen(synthetic.openSchedule).isOpen, 'Mass preflight can create an ordering-open per-group schedule');
  check(!isOrderingOpen(synthetic.closedSchedule).isOpen, 'Mass preflight can create a picking-allowed per-group schedule');
  const [orderIdx, taskIdx, blockIdx] = await Promise.all([Order.collection.indexes(), PickingTask.collection.indexes(), Block.collection.indexes()]);
  check(orderIdx.some((i) => i.name === 'one_active_order_per_buyer_shop_session' && i.unique), 'Mass critical Order unique index exists');
  check(taskIdx.some((i) => i.name === 'one_active_task_per_product_group_session' && i.unique), 'Mass session-scoped PickingTask unique index exists');
  const bi = blockIdx.find((i) => i.name === 'one_product_per_nonempty_block');
  check(Boolean(bi?.unique && bi?.partialFilterExpression), 'Mass Block partial unique index exists');
  const s = await mongoose.connection.startSession();
  try { await s.withTransaction(async () => mongoose.connection.db.collection('counters').findOne({ name: '__mass_tx_probe__' }, { session: s })); }
  finally { s.endSession(); }
  check(!process.env.REDIS_URL, 'Mass process is isolated from Redis', hadRedis ? 'REDIS_URL was configured and disabled for this process' : 'Redis not configured');
  const [oldGroups, oldProducts, orphanManifests] = await Promise.all([
    DeliveryGroup.countDocuments({ name: { $regex: '^__LIVE_E2E' } }),
    Product.countDocuments({ source: 'live_e2e' }),
    AppSetting.countDocuments({ key: /^live-e2e\.run\./ }),
  ]);
  check(oldGroups + oldProducts + orphanManifests === 0,
    'No older live-E2E fixtures/manifests before MASS',
    `groups=${oldGroups} products=${oldProducts} manifests=${orphanManifests}`);
}

async function startApp() {
  const app = require('../app');
  server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const h = await fetchWithTimeout(`${baseUrl}/api/health`, {}, { label: 'GET /api/health', parentSignal: watchdog?.signal }).then((r) => r.json());
  check(h?.status === 'ok', 'Mass ephemeral real Express app is healthy');
}

async function runMass() {
  await createWorld();
  section(`MASS WORLD — ${CFG.sellers} sellers / ${CFG.shops} shops / ${CFG.products} products / ${CFG.warehouses} pickers`);
  log(`RUN_ID=${RUN_ID} seed=${seedNum}`);

  phaseStart('ordering_burst');
  const payloads = world.sellers.map((seller, i) => ({ seller, i, items: orderItemsForSeller(i) }));
  await batchMap(payloads, CFG.orderConcurrency, ({ seller, i, items }) => postOrder(seller, items, `initial:${i}`));
  phaseEnd('ordering_burst');

  eq(world.sessionIds.size, 1, 'All 100 initial Orders land in ONE ordering session');
  const currentSessionId = [...world.sessionIds][0];
  check(Boolean(currentSessionId), 'Mass ordering burst created one current OrderingSession');
  const currentSession = await OrderingSession.findById(currentSessionId);
  check(Boolean(currentSession), 'Mass current OrderingSession exists');

  phaseStart('same_seller_merge_races');
  const raceSellers = world.sellers.slice(0, Math.min(CFG.mergeRaceSellers, world.sellers.length));
  await Promise.all(raceSellers.map(async (seller, idx) => {
    const base = (idx * 7) % CFG.products;
    const requests = [0, 1, 2].map((r) => postOrder(seller, [
      { product: world.products[(base + r) % CFG.products], quantity: 2 + r },
      { product: world.products[(base + 50 + r) % CFG.products], quantity: 3 + r },
    ], `merge:${idx}:${r}`));
    await Promise.all(requests);
  }));
  phaseEnd('same_seller_merge_races');

  const currentActiveCount = await Order.countDocuments({ orderingSessionId: str(currentSessionId), status: { $in: ['new', 'in_progress'] } });
  eq(currentActiveCount, CFG.sellers, '100 concurrent sellers still produce exactly one active Order each');
  await verifyOrderInvariants(currentSessionId);

  await createOldSessionNoise(currentSessionId);
  const closureBefore = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(currentSessionId) });
  check(closureBefore.warnings.some((w) => w.code === 'orphan_tasks'), 'Old orphan tasks are visible as warnings during mass run');
  check(closureBefore.warnings.some((w) => w.code === 'stale_orders'), 'Old stale Orders are visible as warnings during mass run');

  await moveToClosedPhase(currentSession);

  phaseStart('conflict_gate');
  const wh0 = world.warehouses[0];
  const blocked = await startPicking(wh0, true);
  check(blocked.status === 200 && blocked.data?.unresolved === true, 'Mass pre-start conflict gate blocks with many mixed Orders');
  check((blocked.data?.conflicts || []).length >= CFG.conflictShops, 'Mass start reports every conflict shop', `reported=${(blocked.data?.conflicts || []).length}`);
  eq(await PickingTask.countDocuments({ orderingSessionId: str(currentSessionId) }), 0, 'Mass no current-session PickingTask is built before conflicts resolve');

  const secondaryStart = 80;
  const secondaryCount = Math.min(CFG.conflictShops * 2, CFG.sellers - secondaryStart);
  const targetsStart = 80;
  const moves = [];
  for (let j = 0; j < secondaryCount; j += 1) {
    const seller = world.sellers[secondaryStart + j];
    const sourceShopIndex = 70 + Math.floor(j / 2);
    const targetShopIndex = targetsStart + j;
    moves.push(api('POST', '/api/v1/orders/conflicts/resolve', wh0, {
      shopId: str(world.shops[sourceShopIndex]._id), buyerTelegramId: str(seller.telegramId), action: 'move', toShopId: str(world.shops[targetShopIndex]._id),
    }, 'POST conflict-resolve'));
  }
  const moveResults = await Promise.all(moves);
  check(moveResults.every((r) => r.status === 200), 'Mass concurrent conflict moves all succeed');

  const started = await startPicking(wh0, true);
  check(started.status === 200 && started.data?.started === true, 'Mass picking starts only after all conflicts are resolved');
  phaseEnd('conflict_gate');

  const sessAfterStart = await OrderingSession.findById(currentSessionId).lean();
  eq(sessAfterStart.pickingStatus, 'confirmed', 'Mass session is confirmed immediately after start');
  eq((sessAfterStart.shopNumbers || []).length, CFG.sellers, 'Mass box numbering freezes one box per active resolved shop');

  const currentTasks = await PickingTask.find({ orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id) }).sort({ blockId: 1, positionIndex: 1 }).lean();
  eq(currentTasks.length, CFG.products, 'Mass taskBuilder creates exactly one current-session task for every ordered product');
  check(currentTasks.every((t) => t.status === 'pending'), 'Mass all freshly-built tasks are pending');
  const hot0 = currentTasks.find((t) => str(t.productId) === str(world.products[0]._id));
  const hot1 = currentTasks.find((t) => str(t.productId) === str(world.products[1]._id));
  check((hot0?.items || []).length >= Math.floor(CFG.sellers * 0.9), 'Hot product task contains almost every shop', `items=${hot0?.items?.length || 0}`);
  check((hot1?.items || []).length >= Math.floor(CFG.sellers * 0.9), 'Second hot product also stresses large PickingTask.items array', `items=${hot1?.items?.length || 0}`);

  // Race #1: all warehouse users hit the exact same task.
  const raceWin = await claimRace(hot1);
  const hotDone = await fullComplete(raceWin.wh, raceWin.task);
  eq(hotDone.status, 200, 'Hot 100-shop product completes once after claim race');

  // Race #2: progress and completion from the same picker overlap.
  const progressTaskDoc = await PickingTask.findOne({
    orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id), status: 'pending', productId: world.products[10]._id,
  }).lean();
  const progressWh = world.warehouses[1];
  const claimP = await api('POST', `/api/picking/tasks/${progressTaskDoc._id}/claim`, progressWh, {}, 'POST claim');
  eq(claimP.status, 200, 'Mass progress-race task claimed');
  await progressCompleteRace(progressWh, claimP.data.task);

  // Race #3: a stale tab submits OOS at the same time as a normal completion.
  // Exactly one semantic outcome may survive: packed OR out_of_stock, never both.
  const oosRaceTask = await PickingTask.findOne({
    orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id), status: 'pending', productId: world.products[20]._id,
  }).lean();
  const oosRaceWh = world.warehouses[3];
  const claimO = await api('POST', `/api/picking/tasks/${oosRaceTask._id}/claim`, oosRaceWh, {}, 'POST claim');
  eq(claimO.status, 200, 'Mass OOS/complete race task claimed');
  const raceTask = claimO.data.task;
  const racePackedIds = (raceTask.items || []).filter((_, i) => i % 2 === 0).map((i) => str(i.orderId));
  const [raceOos, raceComplete] = await Promise.all([
    api('POST', `/api/picking/tasks/${tid(raceTask)}/out-of-stock`, oosRaceWh, { packedOrderIds: racePackedIds }, 'POST OOS-race'),
    fullComplete(oosRaceWh, raceTask),
  ]);
  check([raceOos.status, raceComplete.status].every((status) => [200, 403, 404, 409].includes(status)),
    'OOS/complete race returns only expected success/conflict statuses',
    `oos=${raceOos.status} complete=${raceComplete.status}`);
  check([raceOos.status, raceComplete.status].filter((x) => x === 200).length >= 1, 'OOS/complete race has a successful winner');
  const raceFinal = await PickingTask.findById(tid(raceTask)).lean();
  check(raceFinal.status === 'completed' && ['packed', 'out_of_stock'].includes(raceFinal.completionReason), 'OOS/complete race leaves one canonical completionReason', raceFinal.completionReason);
  metrics.races.oosComplete = { oos: raceOos.status, complete: raceComplete.status, reason: raceFinal.completionReason };

  // Recovery signal inside a busy session: emulate crash after OOS phase-1.
  const recoveryTask = await PickingTask.findOne({
    orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id), status: 'pending', productId: world.products[30]._id,
  }).lean();
  await PickingTask.updateOne({ _id: recoveryTask._id }, {
    $set: { status: 'completed', completionReason: 'out_of_stock', archiveReconciled: false, completedBy: str(world.warehouses[2].telegramId), completedByName: world.warehouses[2].firstName, completedExpireAt: new Date(Date.now() + 90 * 24 * 3600 * 1000), lockedBy: null, lockedAt: null },
  });
  const recovered = await archiveOrphanedOutOfStockProducts(str(world.group._id), str(currentSessionId));
  check(Number(recovered?.fixedCount || 0) >= 1, 'Mass orphan OOS recovery archives interrupted product while other work still exists', JSON.stringify(recovered));

  // Late Orders after plan freeze: each gets one already-finished product (skip)
  // and one still-pending product (ride-along).
  const pendingLateTask = await PickingTask.findOne({ orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id), status: 'pending' }).sort({ blockId: -1, positionIndex: -1 }).lean();
  const finishedProduct = world.products.find((p) => str(p._id) === str(hot1.productId));
  const pendingProduct = world.products.find((p) => str(p._id) === str(pendingLateTask.productId));
  for (let i = 0; i < world.lateSellers.length; i += 1) {
    const o = await createLateOrder(world.lateSellers[i], currentSessionId, [
      { product: finishedProduct, quantity: 1 + (i % 3) },
      { product: pendingProduct, quantity: 2 + (i % 2) },
    ], `mixed:${i}`);
    const rr = await reconcileLateOrderStrict(o._id);
    check(rr.skipped >= 1 && rr.appended >= 1, 'Mass late Order simultaneously skips passed product and joins pending task', `late=${i} appended=${rr.appended} skipped=${rr.skipped}`);
  }

  // Hidden current-session item with no task: must stop closure later, never vanish.
  const hiddenProduct = await Product.create({
    orderNumber: (await allocProductOrderNumbers(1))[0], price: 7.77, quantity: 999,
    name: `${MARKER}:hidden-product`, brand: `${MARKER}:HIDDEN`, status: 'active', source: 'live_e2e_mass',
  });
  world.products.push(hiddenProduct);
  const victimOrder = await Order.findOne({ orderingSessionId: str(currentSessionId), buyerTelegramId: str(world.sellers[5].telegramId) });
  victimOrder.items.push({ productId: hiddenProduct._id, name: hiddenProduct.name, price: hiddenProduct.price, quantity: 2, packed: false, cancelled: false, skipped: false });
  victimOrder.totalPrice += hiddenProduct.price * 2;
  await victimOrder.save();

  // Wrong-group task + wrong-group Order: explicit "in session but invisible by group" poison.
  const poisonProduct = world.products[5];
  const poisonTask = await PickingTask.create({
    productId: poisonProduct._id, deliveryGroupId: `${world.group._id}-WRONG`, orderingSessionId: str(currentSessionId),
    blockId: world.blocks[0].blockId, positionIndex: 99999, status: 'pending', items: [],
  });
  const poisonOrder = await createLateOrder(world.poisonSeller, currentSessionId, [{ product: finishedProduct, quantity: 1 }], 'wrong-group', `${world.group._id}-WRONG`);
  await saveManifest('poison_injected');

  // Outcome sets: last N blocks go fully OOS, so MULTIPLE Block docs become [].
  const sortedBlocks = [...world.blocks].sort((a, b) => a.blockId - b.blockId);
  const oosBlockIds = new Set(sortedBlocks.slice(-CFG.oosBlocks).map((b) => str(b._id)));
  const oosProductIds = new Set();
  for (const b of world.blocks) if (oosBlockIds.has(str(b._id))) for (const pid of b.productIds) oosProductIds.add(str(pid));
  const shortProductIds = new Set(currentTasks.filter((_, i) => i % 13 === 0).map((t) => str(t.productId)).filter((pid) => !oosProductIds.has(pid)));
  const progressProductIds = new Set(currentTasks.filter((_, i) => i % 17 === 0).map((t) => str(t.productId)).filter((pid) => !oosProductIds.has(pid)));
  // Already-completed/recovered products are harmless in the sets; worker only sees pending.

  section('CONCURRENT PICKING — 12 workers + background read polling');
  phaseStart('concurrent_picking');
  const stop = { value: false };
  const pollers = world.warehouses.slice(0, Math.min(4, world.warehouses.length)).map((wh) => pollDuringPicking(wh, stop));
  const workerPromises = world.warehouses.map((wh, i) => runWorker(
    wh,
    sortedBlocks[i % sortedBlocks.length].blockId,
    currentSessionId,
    { oos: oosProductIds, short: shortProductIds, progress: progressProductIds },
    stop,
  ));
  let workerIterations;
  let workerError = null;
  try {
    workerIterations = await Promise.all(workerPromises);
  } catch (err) {
    workerError = err;
  } finally {
    // Always stop and join background pollers BEFORE propagating a worker
    // failure. Otherwise main() closes the HTTP server while detached pollers
    // are still fetching, producing an unhandled `fetch failed` and obscuring
    // the real failure / cleanup result.
    stop.value = true;
  }
  const pollSettled = await Promise.allSettled(pollers);
  const pollStats = pollSettled.map((r) => r.status === 'fulfilled'
    ? r.value
    : ({ n: 0, failures: 0, transportErrors: 1, error: r.reason?.message || String(r.reason) }));
  phaseEnd('concurrent_picking');
  metrics.counts.workerIterations = workerIterations || [];
  metrics.counts.polls = pollStats;
  check(pollStats.every((x) => x.failures === 0 && x.transportErrors === 0), 'Background closure/lock polling had no 5xx/transport errors during concurrent writes');
  if (workerError) throw workerError;

  const currentPending = await PickingTask.countDocuments({ orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id), status: { $in: ['pending', 'locked'] } });
  eq(currentPending, 0, 'All reachable current-group PickingTasks are terminal after concurrent workers');

  phaseStart('post_picking_integrity');
  // Session MUST still be blocked by the deliberately injected integrity poison.
  const blockedClosure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(currentSessionId) });
  const blockerCodes = blockedClosure.blockers.map((b) => b.code);
  check(!blockedClosure.ok, 'Mass closure refuses to hide deliberately injected integrity failures');
  check(blockerCodes.includes('coverage_gaps'), 'Mass closure exposes hidden OrderItem as coverage_gaps');
  check(blockerCodes.includes('unterminated_items'), 'Mass closure exposes hidden live OrderItem as unterminated_items');
  check(blockerCodes.includes('session_task_group_mismatch'), 'Mass closure exposes wrong-group current-session task');
  check(blockerCodes.includes('session_order_group_mismatch'), 'Mass closure exposes wrong-group current-session Order');
  check(blockedClosure.warnings.some((w) => w.code === 'orphan_tasks') || !(await PickingTask.exists({ orderingSessionId: str(world.oldSessionId), status: { $in: ['pending', 'locked'] } })), 'Old-session debris is warning/repair territory, never a current blocker');
  phaseEnd('post_picking_integrity');

  section('REPAIR FINAL POISON');
  phaseStart('final_repair');
  await PickingTask.deleteOne({ _id: poisonTask._id });
  await Order.updateOne(
    { _id: poisonOrder._id },
    {
      $set: {
        status: 'expired',
        'items.$[open].voided': true,
        'items.$[open].voidReason': 'order_expired',
        'items.$[open].voidedAt': new Date(),
      },
    },
    {
      arrayFilters: [{
        'open.packed': { $ne: true },
        'open.cancelled': { $ne: true },
        'open.skipped': { $ne: true },
        'open.voided': { $ne: true },
      }],
    },
  );
  const repair = await api('POST', '/api/picking/resolve-coverage-gap', wh0, {
    deliveryGroupId: str(world.group._id), productId: str(hiddenProduct._id),
  }, 'POST coverage-repair');
  check(repair.status === 200 && repair.data?.resolved === true, 'Mass hidden item repair resolves final coverage blocker');
  phaseEnd('final_repair');

  phaseStart('final_integrity');
  const finalClosure = await auditSessionClosure({ deliveryGroupId: str(world.group._id), orderingSessionId: str(currentSessionId) });
  check(finalClosure.ok, 'Mass current session has ZERO blockers after explicit repair', JSON.stringify(finalClosure.blockers));
  const finalSession = await OrderingSession.findById(currentSessionId).lean();
  eq(finalSession.pickingStatus, 'completed', 'Mass session reaches completed after all real work + repairs');
  check(Boolean(finalSession.pickingCompletedAt), 'Mass pickingCompletedAt stamped');

  const sessionOrders = await verifyOrderInvariants(currentSessionId);
  const operational = sessionOrders.filter((o) => o.status !== 'expired' && o.buyerSnapshot?.deliveryGroupId === str(world.group._id));
  check(operational.every((o) => (o.items || []).every(terminal)), 'Every operational current-session OrderItem is terminal at finish');
  check(operational.every((o) => ['fulfilled', 'confirmed', 'cancelled'].includes(o.status)), 'Every operational current-session Order has terminal business status');

  const activeLocks = await PickingTask.countDocuments({ orderingSessionId: str(currentSessionId), status: 'locked' });
  eq(activeLocks, 0, 'No locked PickingTask leaks after mass shift');
  const unreconciledOos = await PickingTask.countDocuments({ orderingSessionId: str(currentSessionId), status: 'completed', completionReason: 'out_of_stock', archiveReconciled: { $ne: true } });
  eq(unreconciledOos, 0, 'No unreconciled completed OOS task remains after mass shift');

  const emptyBlockCount = await Block.countDocuments({ _id: { $in: world.blocks.map((b) => b._id) }, productIds: { $size: 0 } });
  check(emptyBlockCount >= CFG.oosBlocks, 'Multiple physical blocks can become empty without E11000', `emptyBlocks=${emptyBlockCount}`);
  const archivedOos = await Product.countDocuments({ _id: { $in: [...oosProductIds] }, status: 'archived' });
  eq(archivedOos, oosProductIds.size, 'Every product from whole OOS blocks is archived under concurrent picking');

  const shortOrders = await Order.countDocuments({ orderingSessionId: str(currentSessionId), 'items.shortfallReason': 'short_pick' });
  check(shortOrders > 0, 'Mass short-pick data survives into Orders', `ordersWithShortPick=${shortOrders}`);

  metrics.counts = {
    ...metrics.counts,
    sellers: CFG.sellers, lateSellers: CFG.lateSellers, shops: CFG.shops, products: CFG.products,
    blocks: world.blocks.length, warehouses: CFG.warehouses,
    sessionOrders: sessionOrders.length,
    currentTasks: await PickingTask.countDocuments({ orderingSessionId: str(currentSessionId), deliveryGroupId: str(world.group._id) }),
    oldTasksRemaining: await PickingTask.countDocuments({ orderingSessionId: str(world.oldSessionId), status: { $in: ['pending', 'locked'] } }),
    emptyBlocks: emptyBlockCount, shortPickOrders: shortOrders,
  };
  phaseEnd('final_integrity');
}

const FINGERPRINT_SPECS = [
  { name: 'orders', model: Order, projection: '_id status orderingSessionId totalPrice updatedAt' },
  { name: 'tasks', model: PickingTask, projection: '_id status deliveryGroupId orderingSessionId lockedBy lockedAt completionReason updatedAt' },
  { name: 'sessions', model: OrderingSession, projection: '_id groupId openDate pickingStatus openNotifiedAt finalSummary updatedAt' },
  { name: 'users', model: User, projection: '_id telegramId role shopId botBlocked updatedAt' },
  { name: 'products', model: Product, projection: '_id status quantity updatedAt' },
  { name: 'blocks', model: Block, projection: '_id blockId productIds version updatedAt' },
  { name: 'groups', model: DeliveryGroup, projection: '_id dayOfWeek orderingSchedule updatedAt' },
  { name: 'shops', model: Shop, projection: '_id deliveryGroupId updatedAt' },
];

function buildReport(error = null) {
  const apiSummary = {};
  for (const [k, v] of Object.entries(metrics.api)) {
    apiSummary[k] = { n: v.n, ok: v.ok, fail: v.fail, p50Ms: percentile(v.ms, 0.5), p95Ms: percentile(v.ms, 0.95), p99Ms: percentile(v.ms, 0.99), maxMs: Math.max(0, ...v.ms) };
  }
  return {
    runId: RUN_ID, marker: MARKER, seed: seedNum, config: CFG,
    db: mongoose.connection?.db?.databaseName || null, host: mongoose.connection?.host || null,
    execute, durationMs: Date.now() - startedAt,
    summary: { passed: assertions.filter((a) => a.ok).length, failed: assertions.filter((a) => !a.ok).length, error: error?.message || null },
    metrics: { ...metrics, api: apiSummary }, assertions,
  };
}
function writeReport(error = null) {
  const report = buildReport(error);
  const base = path.join(REPORT_DIR, `live-e2e-mass-${RUN_ID}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  const lines = [
    `# MASS LIVE E2E ${RUN_ID}`, '',
    `- Result: **${report.summary.failed === 0 && !error ? 'PASS' : 'FAIL'}**`,
    `- Assertions: **${report.summary.passed} passed / ${report.summary.failed} failed**`,
    `- Duration: **${Math.round(report.durationMs / 1000)}s**`,
    `- DB host: \`${report.host || 'unknown'}\``,
    `- Seed: \`${seedNum}\``,
    `- Replay: \`${replayCommand}\``, '',
    '## Load shape',
    `- Sellers ordering: ${CFG.sellers}`,
    `- Late sellers: ${CFG.lateSellers}`,
    `- Shops: ${CFG.shops}`,
    `- Products: ${CFG.products}`,
    `- Blocks: ${CFG.blocks}`,
    `- Concurrent warehouse workers: ${CFG.warehouses}`,
    `- Items per initial Order: ${CFG.itemsPerOrder}`,
    '', '## Phase durations',
    ...Object.entries(report.metrics.phases).map(([k, v]) => `- ${k}: ${v.durationMs == null ? 'incomplete' : `${v.durationMs}ms`}`),
    '', '## API latency',
    ...Object.entries(report.metrics.api).map(([k, v]) => `- ${k}: n=${v.n}, fail=${v.fail}, p50=${v.p50Ms}ms, p95=${v.p95Ms}ms, p99=${v.p99Ms}ms, max=${v.maxMs}ms`),
    '', '## Failed assertions',
    ...(assertions.filter((a) => !a.ok).length ? assertions.filter((a) => !a.ok).map((a) => `- ❌ ${a.name} — ${a.details || ''}`) : ['- none']),
  ];
  fs.writeFileSync(`${base}.md`, lines.join('\n'));
  return base;
}

async function main() {
  let fatal = null;
  try {
    await preflight();
    if (!execute) {
      section('PREFLIGHT ONLY — NO WRITES');
      log(`Ready for mass run: ${CFG.sellers} sellers, ${CFG.products} products, ${CFG.warehouses} warehouse workers.`);
      log('Execute: npm run test:live:e2e:mass');
      return;
    }
    globalLease = await acquireGlobalHarnessLease({ AppSetting, runId: RUN_ID, kind: 'mass', ttlMs: 60 * 60 * 1000 });
    watchdog = createProgressWatchdog({
      name: `MASS ${RUN_ID}`,
      stallMs: 120_000,
      onStall: ({ error }) => console.error(`\n⏱️ ${error.message}\nCleanup: npm run test:live:e2e:cleanup -- --runId=${RUN_ID} --execute`),
      exitOnStallCode: 124,
    });
    await AppSetting.findOneAndUpdate({ key: MANIFEST_KEY }, { $set: { value: { runId: RUN_ID, marker: MARKER, status: 'starting', worlds: {} } } }, { upsert: true });
    baselineFingerprint = await fingerprintCollections(FINGERPRINT_SPECS);
    section('MASS RUN SAFETY');
    log(`RUN_ID=${RUN_ID} seed=${seedNum}`);
    log(`Replay exact randomness + config: ${replayCommand}`);
    log('Global TEST-Atlas harness lease acquired — no contracts/receipt/MASS overlap.');
    log(`If process dies: npm run test:live:e2e:cleanup -- --runId=${RUN_ID} --execute`);
    await startApp();
    watchdog.touch('mass', 'runMass');
    await runMass();
    watchdog.assertHealthy();
  } catch (err) {
    fatal = err;
    assertions.push({ ok: false, name: err.assertionName || 'fatal', details: err.message });
    console.error('\n💥 MASS LIVE E2E FAILED:', err.stack || err.message);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    let clean = false;
    if (execute && world.group) {
      try {
        await cleanup();
        const n = await leftovers();
        clean = n === 0;
        if (!clean) { assertions.push({ ok: false, name: 'mass cleanup', details: `leftovers=${n}` }); console.error(`❌ MASS cleanup leftovers=${n}`); }
        else console.log('🧹 MASS cleanup OK — 0 leftovers');
      } catch (e) {
        assertions.push({ ok: false, name: 'mass cleanup', details: e.message });
        console.error('❌ MASS cleanup failed:', e.stack || e.message);
      }
    }
    if (execute && clean) await AppSetting.deleteOne({ key: MANIFEST_KEY }).catch(() => {});
    if (execute && clean && baselineFingerprint) {
      try {
        const afterFingerprint = await fingerprintCollections(FINGERPRINT_SPECS);
        const drift = compareFingerprints(baselineFingerprint, afterFingerprint);
        check(drift.length === 0, 'MASS changed no unrelated TEST data', drift.length ? JSON.stringify(drift) : 'fingerprints identical');
      } catch (e) {
        assertions.push({ ok: false, name: 'MASS unrelated TEST data fingerprint', details: e.message });
      }
    }
    watchdog?.stop();
    try { if (globalLease) await globalLease.release(); } catch (e) {
      assertions.push({ ok: false, name: 'global harness lease release', details: e.message });
    }
    const reportBase = writeReport(fatal);
    log(`Report: ${reportBase}.md`);
    try { await mongoose.connection.close(false); } catch { /* noop */ }
  }

  section('MASS LIVE E2E RESULT');
  const failed = assertions.filter((a) => !a.ok).length;
  log(`${assertions.length - failed} passed / ${failed} failed assertions`);
  if (fatal || failed) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
