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
const forceActiveOwner = argv.includes('--force-active-owner');
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
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const ProductVector = require('../models/ProductVector');
const ShopProduct = require('../models/ShopProduct');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const { GLOBAL_LOCK_KEY, DEFAULT_LOCK_HEARTBEAT_MS, waitForStableZero, releaseGlobalHarnessLeaseIfOwned } = require('./helpers/liveHarnessSafety');

const manifestKey = `live-e2e.run.${runId}`;

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function uniq(arr) { return [...new Set(arr.map(String).filter(Boolean))]; }
function oidList(arr) {
  return uniq(arr).filter((x) => mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(x));
}

async function collectOrderPicking(manifest) {
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
  let taskIds = oidList(worlds.flatMap((w) => w.taskIds || []));

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
  const taskOr = [];
  if (groupIds.length) taskOr.push({ deliveryGroupId: { $in: groupIds.map(String) } });
  if (sessionIds.length) taskOr.push({ orderingSessionId: { $in: sessionIds.map(String) } });
  if (productIds.length) taskOr.push({ productId: { $in: productIds } });
  if (taskOr.length) {
    const tasks = await PickingTask.find({ $or: taskOr }, '_id').lean();
    taskIds = oidList([...taskIds, ...tasks.map((x) => x._id)]);
  }

  return { marker, groupIds, shopIds, productIds, blockIds, userTelegramIds, sessionIds, orderIds, taskIds };
}

async function countsOrderPicking(ids) {
  const groupStrings = ids.groupIds.map(String);
  const sessionStrings = ids.sessionIds.map(String);
  const orsTasks = [];
  if (ids.taskIds?.length) orsTasks.push({ _id: { $in: ids.taskIds } });
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

async function removeOrderPicking(ids) {
  const groupStrings = ids.groupIds.map(String);
  const sessionStrings = ids.sessionIds.map(String);
  const taskOr = [];
  if (ids.taskIds?.length) taskOr.push({ _id: { $in: ids.taskIds } });
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

async function collectScheduleGuard(manifest) {
  const marker = String(manifest.marker || '');
  if (!marker.startsWith(`__V35_GUARD__${runId}`)) {
    throw new Error('Schedule-guard manifest marker does not match runId; refusing cleanup');
  }
  const g = manifest.guard || {};
  let groupIds = oidList(g.groupIds || []);
  const userMongoIds = oidList(g.userIds || []);
  const [manifestUsers, markerGroups, markerUsers] = await Promise.all([
    userMongoIds.length ? User.find({ _id: { $in: userMongoIds } }, 'telegramId').lean() : [],
    DeliveryGroup.find({ name: { $regex: `^${escRe(marker)}` } }, '_id').lean(),
    User.find({ telegramId: `v35guard-${runId}` }, 'telegramId').lean(),
  ]);
  groupIds = oidList([...groupIds, ...markerGroups.map((x) => x._id)]);
  const userTelegramIds = uniq([...manifestUsers, ...markerUsers].map((x) => x.telegramId));
  const dynamicSessions = groupIds.length ? await OrderingSession.find({ groupId: { $in: groupIds.map(String) } }, '_id').lean() : [];
  const sessionIds = oidList([...(g.sessionIds || []), ...dynamicSessions.map((x) => x._id)]);
  const orderOr = [];
  if (sessionIds.length) orderOr.push({ orderingSessionId: { $in: sessionIds.map(String) } });
  orderOr.push({ buyerTelegramId: { $regex: `^${escRe(marker)}-buyer-` } });
  const dynamicOrders = await Order.find({ $or: orderOr }, '_id').lean();
  const orderIds = oidList([...(g.orderIds || []), ...dynamicOrders.map((x) => x._id)]);
  const taskOr = [];
  if (groupIds.length) taskOr.push({ deliveryGroupId: { $in: groupIds.map(String) } });
  if (sessionIds.length) taskOr.push({ orderingSessionId: { $in: sessionIds.map(String) } });
  const dynamicTasks = taskOr.length ? await PickingTask.find({ $or: taskOr }, '_id').lean() : [];
  const taskIds = oidList([...(g.taskIds || []), ...dynamicTasks.map((x) => x._id)]);
  return {
    marker,
    groupIds,
    shopIds: [],
    productIds: [],
    blockIds: [],
    userTelegramIds,
    sessionIds,
    orderIds,
    taskIds,
  };
}

async function collectReceipt(manifest) {
  const marker = String(manifest.marker || '');
  if (!marker.startsWith(`__LIVE_RECEIPT_E2E__${runId}`)) {
    throw new Error('Receipt manifest marker does not match runId; refusing cleanup');
  }
  const r = manifest.receipt || {};
  let userIds = oidList(r.userIds || []);
  const receiptIds = oidList(r.receiptIds || []);
  const itemIds = oidList(r.itemIds || []);
  let productIds = oidList(r.productIds || []);
  let groupIds = oidList(r.groupIds || []);
  const blockIds = oidList(r.blockIds || []);
  let offerIds = oidList(r.offerIds || []);
  const orderIds = oidList(r.orderIds || []);
  const taskIds = oidList(r.taskIds || []);

  // Marker fallbacks close the crash windows between DB create() and the next
  // manifest save. Receipt fixtures deliberately carry the full random run
  // marker in their receipt/product/group/user identity, so this stays exact to
  // one run and never broadens into normal TEST data.
  const [markerReceipts, markerProducts, markerGroups, markerUsers] = await Promise.all([
    Receipt.find({ receiptNumber: { $regex: `^${escRe(marker)}` } }, '_id').lean(),
    Product.find({ $or: [{ name: marker }, { brand: marker }] }, '_id').lean(),
    DeliveryGroup.find({ name: { $regex: `^${escRe(marker)}` } }, '_id').lean(),
    User.find({ firstName: 'LiveReceipt', lastName: runId }, '_id').lean(),
  ]);
  for (const x of markerReceipts) receiptIds.push(x._id);
  productIds = oidList([...productIds, ...markerProducts.map((x) => x._id)]);
  groupIds = oidList([...groupIds, ...markerGroups.map((x) => x._id)]);
  userIds = oidList([...userIds, ...markerUsers.map((x) => x._id)]);
  const dynamicItems = receiptIds.length ? await ReceiptItem.find({ receiptId: { $in: receiptIds } }, '_id').lean() : [];
  for (const x of dynamicItems) itemIds.push(x._id);
  if (itemIds.length) {
    const [dynamicProducts, dynamicOffers] = await Promise.all([
      Product.find({ receiptItemId: { $in: itemIds } }, '_id').lean(),
      SupplementOffer.find({ receiptItemId: { $in: itemIds } }, '_id').lean(),
    ]);
    productIds = oidList([...productIds, ...dynamicProducts.map((x) => x._id)]);
    offerIds = oidList([...offerIds, ...dynamicOffers.map((x) => x._id)]);
  }
  return {
    kind: 'receipt', marker,
    userIds: oidList(userIds), receiptIds: oidList(receiptIds), itemIds: oidList(itemIds), productIds,
    groupIds: oidList(groupIds), blockIds: oidList(blockIds), offerIds: oidList(offerIds), orderIds: oidList(orderIds), taskIds: oidList(taskIds),
  };
}

async function countsReceipt(ids) {
  const pids = ids.productIds;
  const iids = ids.itemIds;
  const offersOr = [];
  if (ids.offerIds.length) offersOr.push({ _id: { $in: ids.offerIds } });
  if (iids.length) offersOr.push({ receiptItemId: { $in: iids } });
  const taskOr = [];
  if (ids.taskIds.length) taskOr.push({ _id: { $in: ids.taskIds } });
  if (pids.length) taskOr.push({ productId: { $in: pids } });
  const orderOr = [];
  if (ids.orderIds.length) orderOr.push({ _id: { $in: ids.orderIds } });
  if (pids.length) orderOr.push({ 'items.productId': { $in: pids } });
  return {
    users: ids.userIds.length ? await User.countDocuments({ _id: { $in: ids.userIds } }) : 0,
    receipts: ids.receiptIds.length ? await Receipt.countDocuments({ _id: { $in: ids.receiptIds } }) : 0,
    items: iids.length ? await ReceiptItem.countDocuments({ _id: { $in: iids } }) : 0,
    products: pids.length ? await Product.countDocuments({ $or: [{ _id: { $in: pids } }, { receiptItemId: { $in: iids } }] }) : 0,
    vectors: pids.length ? await ProductVector.countDocuments({ productId: { $in: pids } }) : 0,
    shopProducts: (pids.length || iids.length) ? await ShopProduct.countDocuments({ $or: [{ linkedProductId: { $in: pids } }, { receiptItemId: { $in: iids } }] }) : 0,
    blocks: (ids.blockIds.length || pids.length) ? await Block.countDocuments({ $or: [{ _id: { $in: ids.blockIds } }, { productIds: { $in: pids } }] }) : 0,
    orders: orderOr.length ? await Order.countDocuments({ $or: orderOr }) : 0,
    tasks: taskOr.length ? await PickingTask.countDocuments({ $or: taskOr }) : 0,
    offers: offersOr.length ? await SupplementOffer.countDocuments({ $or: offersOr }) : 0,
    requests: ids.offerIds.length ? await SupplementRequest.countDocuments({ offerId: { $in: ids.offerIds } }) : 0,
    logs: ids.receiptIds.length ? await ReceiptItemLog.countDocuments({ receiptId: { $in: ids.receiptIds } }) : 0,
    groups: ids.groupIds.length ? await DeliveryGroup.countDocuments({ _id: { $in: ids.groupIds } }) : 0,
  };
}

async function removeReceipt(ids) {
  const pids = ids.productIds;
  const iids = ids.itemIds;
  if (ids.offerIds.length) await SupplementRequest.deleteMany({ offerId: { $in: ids.offerIds } });
  if (ids.offerIds.length || iids.length) await SupplementOffer.deleteMany({ $or: [
    ...(ids.offerIds.length ? [{ _id: { $in: ids.offerIds } }] : []),
    ...(iids.length ? [{ receiptItemId: { $in: iids } }] : []),
  ] });
  if (ids.taskIds.length || pids.length) await PickingTask.deleteMany({ $or: [
    ...(ids.taskIds.length ? [{ _id: { $in: ids.taskIds } }] : []),
    ...(pids.length ? [{ productId: { $in: pids } }] : []),
  ] });
  if (ids.orderIds.length || pids.length) await Order.deleteMany({ $or: [
    ...(ids.orderIds.length ? [{ _id: { $in: ids.orderIds } }] : []),
    ...(pids.length ? [{ 'items.productId': { $in: pids } }] : []),
  ] });
  if (ids.blockIds.length || pids.length) await Block.deleteMany({ $or: [
    ...(ids.blockIds.length ? [{ _id: { $in: ids.blockIds } }] : []),
    ...(pids.length ? [{ productIds: { $in: pids } }] : []),
  ] });
  if (ids.receiptIds.length) await ReceiptItemLog.deleteMany({ receiptId: { $in: ids.receiptIds } });
  if (pids.length) await ProductVector.deleteMany({ productId: { $in: pids } });
  if (pids.length || iids.length) await ShopProduct.deleteMany({ $or: [
    ...(pids.length ? [{ linkedProductId: { $in: pids } }] : []),
    ...(iids.length ? [{ receiptItemId: { $in: iids } }] : []),
  ] });
  if (iids.length) await ReceiptItem.deleteMany({ _id: { $in: iids } });
  if (pids.length || iids.length) await Product.deleteMany({ $or: [
    ...(pids.length ? [{ _id: { $in: pids } }] : []),
    ...(iids.length ? [{ receiptItemId: { $in: iids } }] : []),
  ] });
  if (ids.receiptIds.length) await Receipt.deleteMany({ _id: { $in: ids.receiptIds } });
  if (ids.groupIds.length) await DeliveryGroup.deleteMany({ _id: { $in: ids.groupIds } });
  if (ids.userIds.length) await User.deleteMany({ _id: { $in: ids.userIds } });
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000, socketTimeoutMS: 30_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  console.log(`DB guard OK: host=${mongoose.connection.host} allowed=${allowedSuffix()}`);
  try {
    const doc = await AppSetting.findOne({ key: manifestKey }).lean();
    if (!doc?.value) {
      throw new Error(`Manifest ${manifestKey} not found. Refusing broad cleanup.`);
    }
    const lock = await AppSetting.findOne({ key: GLOBAL_LOCK_KEY }).lean();
    const lockOwner = String(lock?.value?.runId || '');
    const lockExpires = lock?.value?.expiresAt ? new Date(lock.value.expiresAt).getTime() : 0;
    if (lockOwner && lockOwner !== runId && lockExpires > Date.now()) {
      throw new Error(`Another live harness is active (runId=${lockOwner}); refusing cleanup concurrently.`);
    }
    if (lockOwner === runId && lockExpires > Date.now()) {
      const heartbeatAt = lock?.value?.heartbeatAt ? new Date(lock.value.heartbeatAt).getTime() : 0;
      const heartbeatAgeMs = heartbeatAt ? Date.now() - heartbeatAt : Number.POSITIVE_INFINITY;
      const freshOwnerMs = Math.max(90_000, DEFAULT_LOCK_HEARTBEAT_MS * 3);
      if (heartbeatAgeMs < freshOwnerMs && !forceActiveOwner) {
        throw new Error(
          `Run ${runId} still has a fresh lease heartbeat (${heartbeatAgeMs}ms old). ` +
          `The harness may still be alive; refusing to delete underneath it. ` +
          `After confirming the process is dead, wait for the heartbeat to become stale or pass --force-active-owner.`
        );
      }
      if (forceActiveOwner) {
        console.warn(`⚠️ Forcing cleanup while run ${runId} still owns an unexpired lease. Operator confirmed the process is dead.`);
      } else {
        console.log(`Lease owner matches runId but heartbeat is stale (${heartbeatAgeMs}ms); crash cleanup is allowed.`);
      }
    }
    const kind = doc.value?.kind || '';
    const isReceipt = kind === 'receipt' || String(doc.value?.marker || '').startsWith('__LIVE_RECEIPT_E2E__');
    const isScheduleGuard = kind === 'schedule_guard' || String(doc.value?.marker || '').startsWith('__V35_GUARD__');
    const ids = isReceipt
      ? await collectReceipt(doc.value)
      : isScheduleGuard
        ? await collectScheduleGuard(doc.value)
        : await collectOrderPicking(doc.value);
    const countFn = isReceipt ? countsReceipt : countsOrderPicking;
    const removeFn = isReceipt ? removeReceipt : removeOrderPicking;
    const before = await countFn(ids);
    console.log(`RUN_ID: ${runId}`);
    console.log(`Marker: ${ids.marker}`);
    console.log('Found exact test-owned rows:', before);

    if (!execute) {
      console.log('\nDRY-RUN ONLY. Nothing deleted. To execute:');
      console.log(`node scripts/liveOrderPickingE2ECleanup.js --runId=${runId} --execute`);
      return;
    }

    await removeFn(ids);
    const after = await waitForStableZero(() => countFn(ids), {
      label: `cleanup ${runId}`, quietMs: 800, timeoutMs: 10_000, intervalMs: 150,
      onNonZero: async () => {
        await removeFn(ids);
        if (!isReceipt && ids.groupIds?.length) {
          const gs = ids.groupIds.map(String);
          await OrderingSession.deleteMany({ groupId: { $in: gs } });
          await Counter.deleteMany({ name: { $in: gs.map((g) => `session-seq:${g}`) } });
        }
      },
    });
    await AppSetting.deleteOne({ key: manifestKey });
    await releaseGlobalHarnessLeaseIfOwned({ AppSetting, runId });
    console.log('✅ Cleanup complete. Exact run manifest and owned global lease removed.');
  } finally {
    await mongoose.connection.close(false).catch(() => {});
  }
}

main().catch((err) => {
  console.error('💥 Cleanup failed:', err.message);
  process.exitCode = 1;
});
