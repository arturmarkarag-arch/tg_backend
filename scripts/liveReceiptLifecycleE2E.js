'use strict';

/**
 * TEST-Atlas receipt lifecycle cross-check.
 * Safe default: preflight only. `--execute` creates only synthetic rows and
 * deletes them in finally. Always run through ../dev-use-test-db.js.
 */

const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { assertEnvUriAllowed, assertConnectedHostAllowed, allowedSuffix } = require('../utils/liveE2EDbGuard');
const { buildOpenClosedTestSchedules } = require('./helpers/perGroupTestSchedule');

const execute = process.argv.includes('--execute');
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI не заданий');
  process.exit(2);
}
try { assertEnvUriAllowed(process.env.MONGODB_URI); }
catch (err) { console.error(`⛔ ${err.message}`); process.exit(3); }

const hadRedis = Boolean(process.env.REDIS_URL);
delete process.env.REDIS_URL;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'production';

const User = require('../models/User');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const Block = require('../models/Block');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const DeliveryGroup = require('../models/DeliveryGroup');
const AppSetting = require('../models/AppSetting');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const { signSession } = require('../utils/jwt');
const {
  fetchWithTimeout,
  assertNoActiveGlobalHarnessLease,
  acquireGlobalHarnessLease,
  waitForStableZero,
  fingerprintCollections,
  compareFingerprints,
  createProgressWatchdog,
} = require('./helpers/liveHarnessSafety');

const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const MARKER = `__LIVE_RECEIPT_E2E__${RUN_ID}`;
const MANIFEST_KEY = `live-e2e.run.${RUN_ID}`;
const ids = {
  users: [], receipts: [], items: [], products: [], groups: [], blocks: [], offers: [], orders: [], tasks: [],
};
let server = null;
let baseUrl = '';
let admin = null;
let assertions = 0;
let globalLease = null;
let baselineFingerprint = null;
let watchdog = null;

function ok(condition, name, details = '') {
  watchdog?.touch('assertion', name);
  if (!condition) throw new Error(`${name}${details ? ` — ${details}` : ''}`);
  assertions += 1;
  console.log(`  ✅ ${name}${details ? ` — ${details}` : ''}`);
}
function eq(actual, expected, name) { ok(actual === expected, name, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`); }
function remember(bucket, doc) { if (doc?._id) ids[bucket].push(doc._id); return doc; }
async function saveManifest(phase) {
  await AppSetting.findOneAndUpdate(
    { key: MANIFEST_KEY },
    { $set: { value: {
      kind: 'receipt', runId: RUN_ID, marker: MARKER, phase, updatedAt: new Date().toISOString(),
      receipt: {
        userIds: ids.users.map(String), receiptIds: ids.receipts.map(String), itemIds: ids.items.map(String),
        productIds: ids.products.map(String), groupIds: ids.groups.map(String), blockIds: ids.blocks.map(String),
        offerIds: ids.offers.map(String), orderIds: ids.orders.map(String), taskIds: ids.tasks.map(String),
      },
    } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function token() { return signSession(String(admin.telegramId)); }
async function api(method, route, { json, fields } = {}) {
  watchdog?.touch('http', `${method} ${route}`);
  const headers = { authorization: `Bearer ${await token()}` };
  let body;
  if (fields) {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) fd.append(key, String(value));
    body = fd;
  } else if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetchWithTimeout(`${baseUrl}${route}`, { method, headers, body }, { label: `${method} ${route}`, parentSignal: watchdog?.signal });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

async function seedDraft() {
  const receipt = remember('receipts', await Receipt.create({
    receiptNumber: `${MARKER}-DRAFT-${ids.receipts.length + 1}`,
    status: 'completed', type: 'regular', createdBy: admin.telegramId,
    completedAt: new Date(),
  }));
  const item = remember('items', await ReceiptItem.create({
    receiptId: receipt._id, createdBy: admin.telegramId, status: 'draft', stockApplied: false,
    destination: 'shelf', routingVersion: 1,
    routing: {
      warehouse: false, mandatory: false, supplement: false, mayNotReachAllShops: false,
      supplementDeliveryGroupId: null,
    },
    supplementBatchVersion: 0, supplementPublishRequestedAt: null,
    photoUrl: 'https://example.invalid/live-receipt.jpg', photoName: 'live-receipt.jpg',
    originalPhotoUrl: 'https://example.invalid/live-receipt-original.jpg',
    totalQty: 12, price: null, qtyPerPackage: null,
  }));
  await saveManifest('seed_draft');
  return { receipt, item };
}

async function seedConfirmed({ supplement = false, publishRequested = false, warehouse = true } = {}) {
  const receipt = remember('receipts', await Receipt.create({
    receiptNumber: `${MARKER}-${ids.receipts.length + 1}`,
    status: 'completed', type: 'regular', createdBy: admin.telegramId,
    completedAt: new Date(),
  }));
  const product = remember('products', await Product.create({
    orderNumber: 970_000_000 + ids.products.length,
    price: 2, quantity: 0, quantityPerPackage: 12,
    name: MARKER, brand: MARKER, status: 'pending', source: 'receipt',
    orderingEnabled: warehouse,
    imageUrls: ['https://example.invalid/live-receipt.jpg'], imageNames: ['live-receipt.jpg'],
    originalImageUrl: 'https://example.invalid/live-receipt-original.jpg',
  }));
  const item = remember('items', await ReceiptItem.create({
    receiptId: receipt._id, createdBy: admin.telegramId, status: 'confirmed', stockApplied: true,
    destination: 'shelf', routingVersion: 1,
    routing: {
      warehouse, mandatory: false, supplement, mayNotReachAllShops: false,
      supplementDeliveryGroupId: supplement && publishRequested ? 'pending-group' : null,
    },
    supplementBatchVersion: supplement ? 2 : 0,
    supplementPublishRequestedAt: publishRequested ? new Date() : null,
    photoUrl: 'https://example.invalid/live-receipt.jpg', photoName: 'live-receipt.jpg',
    originalPhotoUrl: 'https://example.invalid/live-receipt-original.jpg',
    totalQty: 12, price: 2, qtyPerPackage: 12, createdProductId: product._id,
  }));
  product.receiptItemId = item._id;
  await product.save();
  await saveManifest('seed_confirmed');
  return { receipt, item, product };
}

async function startApp() {
  const app = require('../app');
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await fetchWithTimeout(`${baseUrl}/api/health`, {}, { label: 'GET /api/health', parentSignal: watchdog?.signal }).then((r) => r.json());
  eq(health.status, 'ok', 'ephemeral Express app is writable');
}

async function cleanupPass() {
  const itemIds = ids.items;
  const dynamicProducts = await Product.find({ receiptItemId: { $in: itemIds } }, '_id').lean();
  const productIds = [...new Set([...ids.products, ...dynamicProducts.map((row) => row._id)].map(String))]
    .map((id) => new mongoose.Types.ObjectId(id));
  await Promise.all([
    SupplementRequest.deleteMany({ offerId: { $in: ids.offers } }),
    SupplementOffer.deleteMany({ $or: [{ _id: { $in: ids.offers } }, { receiptItemId: { $in: itemIds } }] }),
    PickingTask.deleteMany({ $or: [{ _id: { $in: ids.tasks } }, { productId: { $in: productIds } }] }),
    Order.deleteMany({ $or: [{ _id: { $in: ids.orders } }, { 'items.productId': { $in: productIds } }] }),
    Block.deleteMany({ $or: [{ _id: { $in: ids.blocks } }, { productIds: { $in: productIds } }] }),
    ReceiptItemLog.deleteMany({ receiptId: { $in: ids.receipts } }),
    ProductVector.deleteMany({ productId: { $in: productIds } }),
    ShopProduct.deleteMany({ $or: [{ linkedProductId: { $in: productIds } }, { receiptItemId: { $in: itemIds } }] }),
    ReceiptItem.deleteMany({ _id: { $in: itemIds } }),
    Product.deleteMany({ $or: [{ _id: { $in: productIds } }, { receiptItemId: { $in: itemIds } }] }),
    Receipt.deleteMany({ _id: { $in: ids.receipts } }),
    DeliveryGroup.deleteMany({ _id: { $in: ids.groups } }),
    User.deleteMany({ _id: { $in: ids.users } }),
  ]);
}

async function receiptLeftoverCounts() {
  const itemIds = ids.items;
  const dynamicProducts = itemIds.length ? await Product.find({ receiptItemId: { $in: itemIds } }, '_id').lean() : [];
  const productIds = [...new Set([...ids.products, ...dynamicProducts.map((row) => row._id)].map(String))]
    .filter(Boolean).map((id) => new mongoose.Types.ObjectId(id));
  return {
    users: ids.users.length ? await User.countDocuments({ _id: { $in: ids.users } }) : 0,
    receipts: ids.receipts.length ? await Receipt.countDocuments({ _id: { $in: ids.receipts } }) : 0,
    items: itemIds.length ? await ReceiptItem.countDocuments({ _id: { $in: itemIds } }) : 0,
    products: productIds.length ? await Product.countDocuments({ $or: [{ _id: { $in: productIds } }, { receiptItemId: { $in: itemIds } }] }) : 0,
    vectors: productIds.length ? await ProductVector.countDocuments({ productId: { $in: productIds } }) : 0,
    shopProducts: productIds.length || itemIds.length ? await ShopProduct.countDocuments({ $or: [{ linkedProductId: { $in: productIds } }, { receiptItemId: { $in: itemIds } }] }) : 0,
    blocks: productIds.length || ids.blocks.length ? await Block.countDocuments({ $or: [{ _id: { $in: ids.blocks } }, { productIds: { $in: productIds } }] }) : 0,
    orders: productIds.length || ids.orders.length ? await Order.countDocuments({ $or: [{ _id: { $in: ids.orders } }, { 'items.productId': { $in: productIds } }] }) : 0,
    tasks: productIds.length || ids.tasks.length ? await PickingTask.countDocuments({ $or: [{ _id: { $in: ids.tasks } }, { productId: { $in: productIds } }] }) : 0,
    offers: itemIds.length || ids.offers.length ? await SupplementOffer.countDocuments({ $or: [{ _id: { $in: ids.offers } }, { receiptItemId: { $in: itemIds } }] }) : 0,
    logs: ids.receipts.length ? await ReceiptItemLog.countDocuments({ receiptId: { $in: ids.receipts } }) : 0,
    groups: ids.groups.length ? await DeliveryGroup.countDocuments({ _id: { $in: ids.groups } }) : 0,
  };
}

async function cleanup() {
  await cleanupPass();
  await waitForStableZero(receiptLeftoverCounts, {
    label: 'Receipt E2E cleanup', quietMs: 700, timeoutMs: 8_000, intervalMs: 120,
    onNonZero: () => cleanupPass(),
  });
}

async function preflight() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000, socketTimeoutMS: 30_000 });
  assertConnectedHostAllowed(mongoose.connection.host);
  await assertNoActiveGlobalHarnessLease({ AppSetting });
  ok(true, 'No active global live-harness lease');
  console.log(`DB: ${mongoose.connection.db.databaseName} @ ${mongoose.connection.host} (${allowedSuffix()})`);
  ok(!hadRedis || !process.env.REDIS_URL, 'Redis isolated');

  const offerIndexes = await SupplementOffer.collection.indexes();
  ok(offerIndexes.some((idx) => idx.unique && idx.key?.receiptItemId === 1 && idx.key?.deliveryGroupId === 1), 'SupplementOffer item+group unique index exists');
  const blockIndexes = await Block.collection.indexes();
  ok(blockIndexes.some((idx) => idx.name === 'one_product_per_nonempty_block' && idx.unique), 'Block membership unique index exists');

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection('receipts').findOne({ receiptNumber: '__receipt_e2e_tx_probe__' }, { session });
    });
    ok(true, 'Mongo transaction round-trip');
  } finally { session.endSession(); }

  const [leftovers, orphanManifests] = await Promise.all([
    Receipt.countDocuments({ receiptNumber: { $regex: '^__LIVE_RECEIPT_E2E__' } }),
    AppSetting.countDocuments({ key: /^live-e2e\.run\./ }),
  ]);
  eq(leftovers + orphanManifests, 0, 'No previous receipt/live-E2E leftovers or orphan manifests');
}

const FINGERPRINT_SPECS = [
  { name: 'orders', model: Order, projection: '_id status orderingSessionId totalPrice updatedAt' },
  { name: 'tasks', model: PickingTask, projection: '_id status deliveryGroupId orderingSessionId lockedBy lockedAt completionReason updatedAt' },
  { name: 'users', model: User, projection: '_id telegramId role shopId botBlocked updatedAt' },
  { name: 'products', model: Product, projection: '_id status quantity receiptItemId updatedAt' },
  { name: 'blocks', model: Block, projection: '_id blockId productIds version updatedAt' },
  { name: 'groups', model: DeliveryGroup, projection: '_id dayOfWeek orderingSchedule updatedAt' },
  { name: 'receipts', model: Receipt, projection: '_id receiptNumber status updatedAt' },
  { name: 'receiptItems', model: ReceiptItem, projection: '_id receiptId status routing stockApplied updatedAt' },
];

async function run() {
  admin = remember('users', await User.create({ telegramId: `-98${Date.now()}`, role: 'admin', firstName: 'LiveReceipt', lastName: RUN_ID }));
  await saveManifest('admin_created');
  await startApp();

  console.log('\nScenario 0: real draft -> preparation -> routing -> confirm -> edit -> rollback');
  {
    const { receipt, item } = await seedDraft();
    const prep = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, {
      fields: { price: 2.5, qtyPerPackage: 12 },
    });
    eq(prep.status, 200, 'commercial preparation saves through HTTP');

    const route = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}/routing`, {
      json: { warehouse: true, mandatory: false, supplement: false },
    });
    eq(route.status, 200, 'routing saves after preparation');
    ok(route.data.routing?.warehouse, 'warehouse route persisted');

    const confirmed = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/confirm`);
    eq(confirmed.status, 200, 'prepared routed item confirms');
    eq(confirmed.data.status, 'confirmed', 'item is confirmed');

    const product = await Product.findOne({ receiptItemId: item._id }).lean();
    ok(product?._id, 'confirm creates warehouse Product');
    remember('products', product);
    const mirror = await ShopProduct.findOne({ linkedProductId: product._id }).lean();
    ok(mirror?._id, 'confirm creates shop mirror');

    const correction = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { price: 3 } });
    eq(correction.status, 200, 'commercial correction is allowed before downstream use');
    eq((await Product.findById(product._id).lean()).price, 3, 'Product receives corrected price');
    eq((await ShopProduct.findOne({ linkedProductId: product._id }).lean()).price, 3, 'mirror receives corrected price');

    const rollback = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    eq(rollback.status, 200, 'clean confirmed item can roll back');
    eq(await Product.countDocuments({ receiptItemId: item._id }), 0, 'rollback removes Product');
    eq(await ShopProduct.countDocuments({ linkedProductId: product._id }), 0, 'rollback removes Product mirror');
  }

  console.log('\nScenario 1: reversible before publication');
  {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, warehouse: false });
    const res = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    eq(res.status, 200, 'unconfirm before publish succeeds');
    eq((await ReceiptItem.findById(item._id).lean()).status, 'draft', 'item returned to draft');
    eq(await Product.countDocuments({ _id: product._id }), 0, 'derived product rolled back');

    const reroute = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}/routing`, {
      json: { warehouse: true, mandatory: false, supplement: false },
    });
    eq(reroute.status, 200, 'draft may be reassigned after clean rollback');
    const reconfirm = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/confirm`);
    eq(reconfirm.status, 200, 'reassigned draft can confirm again');
    ok(reconfirm.data.routing?.warehouse && !reconfirm.data.routing?.supplement, 'new route owns reconfirmed item');
  }

  console.log('\nScenario 2: deferred publication is irreversible');
  {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    const unconfirm = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    eq(unconfirm.status, 409, 'deferred publish blocks unconfirm');
    const remove = await api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`);
    eq(remove.status, 409, 'deferred publish blocks delete');
    const edit = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { price: 3 } });
    eq(edit.status, 409, 'deferred publish blocks price edit');
    eq((await Product.findById(product._id).lean()).price, 2, 'product price unchanged');
  }

  console.log('\nScenario 3: every published offer state is irreversible even with zero requests');
  for (const status of ['open', 'frozen', 'completed']) {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    const offer = remember('offers', await SupplementOffer.create({
      receiptId: receipt._id, receiptItemId: item._id, productId: product._id,
      deliveryGroupId: `g-live-${status}`, status,
    }));
    eq(await SupplementRequest.countDocuments({ offerId: offer._id }), 0, `${status} offer starts with zero requests`);
    const rollback = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    eq(rollback.status, 409, `${status} offer blocks unconfirm`);
    const remove = await api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`);
    eq(remove.status, 409, `${status} offer blocks delete`);
    const edit = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { qtyPerPackage: 24 } });
    eq(edit.status, 409, `${status} offer blocks commercial edit`);
  }

  console.log('\nScenario 4: concurrent batch assignment chooses one group');
  {
    const { deliveryDay, openSchedule } = buildOpenClosedTestSchedules();
    const [a, b] = await Promise.all([
      DeliveryGroup.create({ name: `${MARKER}-A`, dayOfWeek: deliveryDay, orderingSchedule: openSchedule }),
      DeliveryGroup.create({ name: `${MARKER}-B`, dayOfWeek: deliveryDay, orderingSchedule: openSchedule }),
    ]);
    remember('groups', a); remember('groups', b); await saveManifest('groups_seeded');
    const { item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [ra, rb] = await Promise.all([
      api('POST', `/api/receipts/supplement-batches/${a._id}/publish`),
      api('POST', `/api/receipts/supplement-batches/${b._id}/publish`),
    ]);
    eq(ra.status, 200, 'batch publish A returned');
    eq(rb.status, 200, 'batch publish B returned');
    eq(Number(ra.data.selectedCount || 0) + Number(rb.data.selectedCount || 0), 1, 'only one concurrent group claims item');
    const fresh = await ReceiptItem.findById(item._id).lean();
    const chosen = String(fresh.routing.supplementDeliveryGroupId || '');
    ok([String(a._id), String(b._id)].includes(chosen), 'item assigned to exactly one requested group');
    ok(fresh.supplementPublishRequestedAt, 'publication marker persisted');
    eq(await SupplementOffer.countDocuments({ receiptItemId: item._id }), 0, 'open ordinary window defers offer creation');
    const other = chosen === String(a._id) ? b : a;
    const retry = await api('POST', `/api/receipts/supplement-batches/${other._id}/publish`);
    eq(retry.data.selectedCount, 0, 'second group cannot reassign claimed item');
  }

  console.log('\nScenario 5: block membership freezes receipt rollback and commercial edit');
  {
    const { receipt, item, product } = await seedConfirmed();
    remember('blocks', await Block.create({ blockId: 980000 + ids.blocks.length, productIds: [product._id] }));
    const edit = await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { qtyPerPackage: 24 } });
    eq(edit.status, 409, 'block membership blocks package edit');
    eq((await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status, 409, 'block membership blocks unconfirm');
    eq((await api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`)).status, 409, 'block membership blocks delete');
  }

  console.log('\nScenario 6: order usage alone freezes receipt');
  {
    const { receipt, item, product } = await seedConfirmed();
    remember('orders', await Order.create({
      orderNumber: 980000000 + ids.orders.length, buyerTelegramId: `-${Date.now()}1`, status: 'new',
      items: [{ productId: product._id, name: MARKER, price: 2, quantity: 1 }], totalPrice: 2,
    }));
    eq((await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { price: 4 } })).status, 409, 'order blocks price edit');
    eq((await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status, 409, 'order blocks unconfirm');
    eq((await api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`)).status, 409, 'order blocks delete');
  }

  console.log('\nScenario 7: picking usage alone freezes receipt');
  {
    const { receipt, item, product } = await seedConfirmed();
    remember('tasks', await PickingTask.create({
      productId: product._id, deliveryGroupId: `${MARKER}-g`, blockId: 981000 + ids.tasks.length,
      positionIndex: 0, status: 'pending',
    }));
    eq((await api('PATCH', `/api/receipts/${receipt._id}/items/${item._id}`, { fields: { price: 4 } })).status, 409, 'picking blocks price edit');
    eq((await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status, 409, 'picking blocks unconfirm');
    eq((await api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`)).status, 409, 'picking blocks delete');
  }

  console.log('\nScenario 8: additive warehouse remainder remains allowed');
  {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    item.routing.supplementDeliveryGroupId = 'g-live';
    await item.save();
    remember('offers', await SupplementOffer.create({
      receiptId: receipt._id, receiptItemId: item._id, productId: product._id,
      deliveryGroupId: 'g-live', status: 'open',
    }));
    const res = await api('POST', `/api/receipts/${receipt._id}/items/${item._id}/add-warehouse-remainder`);
    eq(res.status, 200, 'additive remainder succeeds after supplement publication');
    ok(res.data.routing?.warehouse && res.data.routing?.supplement, 'primary supplement route preserved with warehouse=true');
    eq(await SupplementOffer.countDocuments({ receiptItemId: item._id }), 1, 'supplement offer preserved');
  }

  console.log('\nScenario 9: publication races cannot split receipt state');
  {
    const { deliveryDay, openSchedule } = buildOpenClosedTestSchedules();
    const group = remember('groups', await DeliveryGroup.create({
      name: `${MARKER}-RACE-U`, dayOfWeek: deliveryDay, orderingSchedule: openSchedule,
    }));
    await saveManifest('race_unconfirm_group');
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [publish, rollback] = await Promise.all([
      api('POST', `/api/receipts/supplement-batches/${group._id}/publish`),
      api('POST', `/api/receipts/${receipt._id}/items/${item._id}/unconfirm`),
    ]);
    eq(publish.status, 200, 'publish/unconfirm race publish endpoint returns');
    ok([200, 409].includes(rollback.status), 'publish/unconfirm race has a valid rollback outcome');
    const fresh = await ReceiptItem.findById(item._id).lean();
    if (rollback.status === 200) {
      eq(publish.data.selectedCount, 0, 'rollback winner prevents batch claim');
      eq(fresh.status, 'draft', 'rollback winner leaves draft');
      ok(!fresh.supplementPublishRequestedAt, 'rollback winner leaves no publication marker');
    } else {
      eq(publish.data.selectedCount, 1, 'publish winner claims exactly once');
      eq(fresh.status, 'confirmed', 'publish winner keeps confirmed item');
      ok(fresh.supplementPublishRequestedAt, 'publish winner keeps publication marker');
      eq(String(fresh.routing.supplementDeliveryGroupId), String(group._id), 'publish winner keeps selected group');
    }
  }

  {
    const { deliveryDay, openSchedule } = buildOpenClosedTestSchedules();
    const group = remember('groups', await DeliveryGroup.create({
      name: `${MARKER}-RACE-D`, dayOfWeek: deliveryDay, orderingSchedule: openSchedule,
    }));
    await saveManifest('race_delete_group');
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [publish, remove] = await Promise.all([
      api('POST', `/api/receipts/supplement-batches/${group._id}/publish`),
      api('DELETE', `/api/receipts/${receipt._id}/items/${item._id}`),
    ]);
    eq(publish.status, 200, 'publish/delete race publish endpoint returns');
    ok([200, 409].includes(remove.status), 'publish/delete race has a valid delete outcome');
    const fresh = await ReceiptItem.findById(item._id).lean();
    if (remove.status === 200) {
      eq(publish.data.selectedCount, 0, 'delete winner prevents batch claim');
      ok(!fresh, 'delete winner leaves no receipt item');
    } else {
      eq(publish.data.selectedCount, 1, 'publish winner prevents delete');
      ok(fresh?.supplementPublishRequestedAt, 'published item survives delete race');
      eq(String(fresh.routing.supplementDeliveryGroupId), String(group._id), 'published item keeps selected group after delete race');
    }
  }
}

async function main() {
  let scenarioRunPassed = false;
  try {
    await preflight();
    if (!execute) {
      console.log('\nPREFLIGHT ONLY — no rows created.');
      console.log('Run with --execute through test DB preload to execute receipt lifecycle scenarios.');
      return;
    }
    globalLease = await acquireGlobalHarnessLease({ AppSetting, runId: RUN_ID, kind: 'receipt' });
    watchdog = createProgressWatchdog({
      name: `LIVE RECEIPT ${RUN_ID}`, stallMs: 120_000, exitOnStallCode: 124,
      onStall: ({ error }) => console.error(`\n⏱️ ${error.message}\nCleanup: npm run test:live:e2e:cleanup -- --runId=${RUN_ID} --execute`),
    });
    await saveManifest('starting');
    baselineFingerprint = await fingerprintCollections(FINGERPRINT_SPECS);
    console.log(`RUN_ID=${RUN_ID} · global TEST-Atlas harness lease acquired`);
    console.log(`If process dies: npm run test:live:e2e:cleanup -- --runId=${RUN_ID} --execute`);
    await run();
    scenarioRunPassed = true;
    console.log(`\n✅ LIVE RECEIPT scenarios completed — ${assertions} assertions; cleanup/fingerprint pending`);
  } catch (err) {
    console.error(`\n❌ LIVE RECEIPT E2E FAIL — ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (execute) {
      let clean = false;
      try {
        await cleanup();
        clean = true;
        console.log('🧹 Synthetic receipt fixtures cleaned and stable-zero verified');
      } catch (err) {
        console.error(`❌ cleanup failed: ${err.stack || err.message}`);
        process.exitCode = 1;
      }
      if (clean && baselineFingerprint) {
        try {
          const afterFingerprint = await fingerprintCollections(FINGERPRINT_SPECS);
          const drift = compareFingerprints(baselineFingerprint, afterFingerprint);
          ok(drift.length === 0, 'Receipt E2E changed no unrelated TEST data', drift.length ? JSON.stringify(drift) : 'fingerprints identical');
        } catch (err) {
          console.error(`❌ fingerprint verification failed: ${err.message}`);
          process.exitCode = 1;
        }
      }
      if (clean) await AppSetting.deleteOne({ key: MANIFEST_KEY }).catch(() => {});
      watchdog?.stop();
      try { if (globalLease) await globalLease.release(); } catch (err) {
        console.error(`❌ global harness lease release failed: ${err.message}`);
        process.exitCode = 1;
      }
      if (scenarioRunPassed && !process.exitCode) {
        console.log(`\n✅ LIVE RECEIPT E2E PASS — ${assertions} assertions · cleanup stable · unrelated data unchanged`);
      }
    }
    try { await mongoose.connection.close(false); } catch (_) {}
  }
}

main();
