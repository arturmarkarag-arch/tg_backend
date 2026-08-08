'use strict';

/**
 * Crash-safe cleanup for scripts/liveOrderPickingE2E.js.
 *
 * This script REFUSES to do a broad cleanup. It requires an exact RUN_ID and
 * an exact run manifest (`AppSetting.key = live-e2e.run.<RUN_ID>`). It removes
 * only fixtures registered by that run plus rows carrying the exact random
 * run marker from that same manifest.
 *
 * Dry-run (default):
 *   node scripts/liveOrderPickingE2ECleanup.js --runId=20260807224300-abc123
 * Execute:
 *   node scripts/liveOrderPickingE2ECleanup.js --runId=20260807224300-abc123 --execute
 */

const fs = require('fs');
const path = require('path');
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
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
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
const runArg = argv.find((a) => a.startsWith('--runId='));
const runId = runArg ? runArg.slice('--runId='.length).trim() : '';

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI не заданий.');
  process.exit(2);
}
try {
  assertEnvUriAllowed(process.env.MONGODB_URI);
} catch (err) {
  console.error(`⛔ ${err.message}`);
  process.exit(3);
}
if (!/^\d{14}-[0-9a-f]{6}$/.test(runId)) {
  console.error('❌ Потрібен точний --runId=YYYYMMDDhhmmss-abcdef із виводу live E2E.');
  process.exit(2);
}

const mongoose = require('mongoose');
const AppSetting = require('../models/AppSetting');
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

const manifestKey = `live-e2e.run.${runId}`;

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function uniq(arr) { return [...new Set(arr.map(String).filter(Boolean))]; }
function oidList(arr) {
  return uniq(arr).filter((x) => mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(x));
}

async function collect(manifest) {
  const marker = String(manifest.marker || '');
  const markerMatches = marker.startsWith(`__LIVE_E2E__${runId}`) || marker.startsWith(`__LIVE_E2E_MASS__${runId}`);
  if (!markerMatches) throw new Error('Manifest marker does not match runId; refusing cleanup');
  const worlds = Object.values(manifest.worlds || {});

  let groupIds = oidList(worlds.map((w) => w.groupId));
  let shopIds = oidList(worlds.flatMap((w) => w.shopIds || []));
  let productIds = oidList(worlds.flatMap((w) => w.productIds || []));
  let blockIds = oidList(worlds.flatMap((w) => [w.blockMongoId, ...(w.blockMongoIds || [])]));
  let userTelegramIds = uniq(worlds.flatMap((w) => w.userTelegramIds || []));
  let sessionIds = oidList(worlds.flatMap((w) => w.sessionIds || []));
  let orderIds = oidList(worlds.flatMap((w) => w.orderIds || []));

  // Exact random marker fallback closes the tiny crash window between creating a
  // test fixture and persisting its id into the manifest. It cannot match a real
  // customer because every E2E-created name includes this full per-run marker.
  const markerRe = new RegExp(`^${escRe(marker)}:`);
  const [markerGroups, markerShops, markerProducts, markerUsers] = await Promise.all([
    DeliveryGroup.find({ name: markerRe }, '_id').lean(),
    Shop.find({ name: markerRe }, '_id').lean(),
    Product.find({ name: markerRe }, '_id').lean(),
    User.find({ lastName: runId, firstName: /^(E2E_|MASS_)/ }, 'telegramId').lean(),
  ]);
  groupIds = oidList([...groupIds, ...markerGroups.map((x) => x._id)]);
  shopIds = oidList([...shopIds, ...markerShops.map((x) => x._id)]);
  productIds = oidList([...productIds, ...markerProducts.map((x) => x._id)]);
  userTelegramIds = uniq([...userTelegramIds, ...markerUsers.map((x) => x.telegramId)]);

  if (groupIds.length) {
    const sessions = await OrderingSession.find({ groupId: { $in: groupIds.map(String) } }, '_id').lean();
    sessionIds = oidList([...sessionIds, ...sessions.map((x) => x._id)]);
  }
  if (userTelegramIds.length || sessionIds.length) {
    const ors = [];
    if (userTelegramIds.length) ors.push({ buyerTelegramId: { $in: userTelegramIds } });
    if (sessionIds.length) ors.push({ orderingSessionId: { $in: sessionIds.map(String) } });
    const orders = await Order.find({ $or: ors }, '_id').lean();
    orderIds = oidList([...orderIds, ...orders.map((x) => x._id)]);
  }
  if (productIds.length) {
    const markerBlocks = await Block.find({ productIds: { $in: productIds } }, '_id').lean();
    blockIds = oidList([...blockIds, ...markerBlocks.map((x) => x._id)]);
  }

  return { marker, groupIds, shopIds, productIds, blockIds, userTelegramIds, sessionIds, orderIds };
}

async function counts(ids) {
  const groupStrings = ids.groupIds.map(String);
  const sessionStrings = ids.sessionIds.map(String);
  const orsTasks = [];
  if (groupStrings.length) orsTasks.push({ deliveryGroupId: { $in: groupStrings } });
  if (sessionStrings.length) orsTasks.push({ orderingSessionId: { $in: sessionStrings } });
  if (ids.productIds.length) orsTasks.push({ productId: { $in: ids.productIds } });
  return {
    groups: ids.groupIds.length ? await DeliveryGroup.countDocuments({ _id: { $in: ids.groupIds } }) : 0,
    shops: ids.shopIds.length ? await Shop.countDocuments({ _id: { $in: ids.shopIds } }) : 0,
    users: ids.userTelegramIds.length ? await User.countDocuments({ telegramId: { $in: ids.userTelegramIds } }) : 0,
    products: ids.productIds.length ? await Product.countDocuments({ _id: { $in: ids.productIds } }) : 0,
    blocks: ids.blockIds.length ? await Block.countDocuments({ _id: { $in: ids.blockIds } }) : 0,
    sessions: ids.sessionIds.length ? await OrderingSession.countDocuments({ _id: { $in: ids.sessionIds } }) : 0,
    orders: ids.orderIds.length ? await Order.countDocuments({ _id: { $in: ids.orderIds } }) : 0,
    tasks: orsTasks.length ? await PickingTask.countDocuments({ $or: orsTasks }) : 0,
    shopAuditLogs: ids.userTelegramIds.length ? await ShopAuditLog.countDocuments({
      $or: [
        { sellerTelegramId: { $in: ids.userTelegramIds } },
        { actorTelegramId: { $in: ids.userTelegramIds } },
      ],
    }) : 0,
    counters: groupStrings.length ? await Counter.countDocuments({ name: { $in: groupStrings.map((g) => `session-seq:${g}`) } }) : 0,
  };
}

async function remove(ids) {
  const groupStrings = ids.groupIds.map(String);
  const sessionStrings = ids.sessionIds.map(String);
  const taskOr = [];
  if (groupStrings.length) taskOr.push({ deliveryGroupId: { $in: groupStrings } });
  if (sessionStrings.length) taskOr.push({ orderingSessionId: { $in: sessionStrings } });
  if (ids.productIds.length) taskOr.push({ productId: { $in: ids.productIds } });

  if (taskOr.length) await PickingTask.deleteMany({ $or: taskOr });
  if (ids.orderIds.length) await Order.deleteMany({ _id: { $in: ids.orderIds } });
  if (ids.userTelegramIds.length) {
    await ShopAuditLog.deleteMany({
      $or: [
        { sellerTelegramId: { $in: ids.userTelegramIds } },
        { actorTelegramId: { $in: ids.userTelegramIds } },
      ],
    });
  }
  if (ids.sessionIds.length) await OrderingSession.deleteMany({ _id: { $in: ids.sessionIds } });
  if (groupStrings.length) await Counter.deleteMany({ name: { $in: groupStrings.map((g) => `session-seq:${g}`) } });
  if (ids.blockIds.length) await Block.deleteMany({ _id: { $in: ids.blockIds } });
  if (ids.productIds.length) await Product.deleteMany({ _id: { $in: ids.productIds } });
  if (ids.userTelegramIds.length) await User.deleteMany({ telegramId: { $in: ids.userTelegramIds } });
  if (ids.shopIds.length) await Shop.deleteMany({ _id: { $in: ids.shopIds } });
  if (ids.groupIds.length) await DeliveryGroup.deleteMany({ _id: { $in: ids.groupIds } });
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  console.log(`DB guard OK: host=${mongoose.connection.host} allowed=${allowedSuffix()}`);
  try {
    const doc = await AppSetting.findOne({ key: manifestKey }).lean();
    if (!doc?.value) {
      throw new Error(`Manifest ${manifestKey} not found. Refusing broad cleanup.`);
    }
    const ids = await collect(doc.value);
    const before = await counts(ids);
    console.log(`RUN_ID: ${runId}`);
    console.log(`Marker: ${ids.marker}`);
    console.log('Found exact test-owned rows:', before);

    if (!execute) {
      console.log('\nDRY-RUN ONLY. Nothing deleted. To execute:');
      console.log(`node scripts/liveOrderPickingE2ECleanup.js --runId=${runId} --execute`);
      return;
    }

    await remove(ids);
    // A delayed per-group counter/session can be created by a fire-and-forget
    // ensureSessionSeq just after a request. Scrub exact test group ids twice.
    await new Promise((r) => setTimeout(r, 150));
    if (ids.groupIds.length) {
      const gs = ids.groupIds.map(String);
      await OrderingSession.deleteMany({ groupId: { $in: gs } });
      await Counter.deleteMany({ name: { $in: gs.map((g) => `session-seq:${g}`) } });
    }

    const after = await counts(ids);
    const leftovers = Object.values(after).reduce((a, b) => a + Number(b || 0), 0);
    if (leftovers) {
      console.error('❌ Cleanup incomplete. Manifest kept for retry:', after);
      process.exitCode = 1;
      return;
    }
    await AppSetting.deleteOne({ key: manifestKey });
    console.log('✅ Cleanup complete. Exact run manifest removed.');
  } finally {
    await mongoose.connection.close(false).catch(() => {});
  }
}

main().catch((err) => {
  console.error('💥 Cleanup failed:', err.message);
  process.exitCode = 1;
});
