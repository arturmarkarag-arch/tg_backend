'use strict';

/**
 * Read-only operational contract audit.
 *
 * NEVER mutates data. Its job is to make the intended business invariants visible
 * before we harden them with unique indexes / repair actions:
 *
 *   Shop -> one delivery group
 *   Shop -> at most one seller
 *   Shop + OrderingSession -> at most one active order (target contract)
 *   PickingTask -> one active product task per group + session
 *   Historical sessions may remain dirty, but may not consume current-session slots.
 *
 * Usage:
 *   node scripts/auditOperationalContracts.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

function id(v) { return v == null ? '' : String(v); }

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const users = db.collection('users');
  const shops = db.collection('shops');
  const groups = db.collection('deliverygroups');
  const orders = db.collection('orders');
  const tasks = db.collection('pickingtasks');
  const sessions = db.collection('orderingsessions');

  console.log(`База: ${db.databaseName}`);
  console.log('Режим: READ-ONLY\n');

  const shopDocs = await shops.find({}, { projection: { name: 1, deliveryGroupId: 1, isActive: 1 } }).toArray();
  const groupIds = new Set((await groups.find({}, { projection: { _id: 1 } }).toArray()).map((g) => id(g._id)));
  const shopById = new Map(shopDocs.map((s) => [id(s._id), s]));

  const shopsWithoutGroup = shopDocs.filter((s) => !s.deliveryGroupId || !groupIds.has(id(s.deliveryGroupId)));

  // Contract candidate: one SELLER per shop. Admin/warehouse assignments are not counted.
  const sellers = await users.find(
    { role: 'seller', shopId: { $ne: null } },
    { projection: { telegramId: 1, firstName: 1, lastName: 1, shopId: 1 } },
  ).toArray();
  const sellersByShop = new Map();
  for (const seller of sellers) {
    const sid = id(seller.shopId);
    if (!sid) continue;
    if (!sellersByShop.has(sid)) sellersByShop.set(sid, []);
    sellersByShop.get(sid).push(seller);
  }
  const multiSellerShops = [...sellersByShop.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([shopId, list]) => ({ shopId, shop: shopById.get(shopId)?.name || '—', sellers: list }));

  // Current DB invariant is buyer+shop+session. This audit shows where the stricter
  // desired shop+session invariant would currently fail.
  const duplicateShopSessionOrders = await orders.aggregate([
    { $match: {
      status: { $in: ['new', 'in_progress'] },
      shopId: { $type: 'objectId' },
      orderingSessionId: { $type: 'string', $gt: '' },
    } },
    { $group: {
      _id: { shopId: '$shopId', orderingSessionId: '$orderingSessionId' },
      count: { $sum: 1 },
      buyers: { $addToSet: '$buyerTelegramId' },
      orderIds: { $push: '$_id' },
    } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  const activeTasksWithoutSession = await tasks.find(
    { status: { $in: ['pending', 'locked'] }, $or: [{ orderingSessionId: null }, { orderingSessionId: '' }, { orderingSessionId: { $exists: false } }] },
    { projection: { productId: 1, deliveryGroupId: 1, orderingSessionId: 1, status: 1, blockId: 1, positionIndex: 1 } },
  ).toArray();

  const duplicateTaskKeys = await tasks.aggregate([
    { $match: {
      status: { $in: ['pending', 'locked'] },
      orderingSessionId: { $type: 'string', $gt: '' },
    } },
    { $group: {
      _id: { productId: '$productId', deliveryGroupId: '$deliveryGroupId', orderingSessionId: '$orderingSessionId' },
      count: { $sum: 1 },
      taskIds: { $push: '$_id' },
    } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  // This is ALLOWED after session isolation. We report it to prove that historical
  // work can coexist without sharing a unique slot with the current cycle.
  const crossSessionActiveTasks = await tasks.aggregate([
    { $match: { status: { $in: ['pending', 'locked'] } } },
    { $group: {
      _id: { productId: '$productId', deliveryGroupId: '$deliveryGroupId' },
      sessions: { $addToSet: '$orderingSessionId' },
      count: { $sum: 1 },
    } },
    { $match: { 'sessions.1': { $exists: true } } },
  ]).toArray();

  const duplicateSessions = await sessions.aggregate([
    { $group: { _id: { groupId: '$groupId', openDate: '$openDate' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  console.log('=== CONTRACT AUDIT ===');
  console.log(`Shops: ${shopDocs.length}; без валідної deliveryGroup: ${shopsWithoutGroup.length}`);
  console.log(`Sellers з shopId: ${sellers.length}; магазини з 2+ seller: ${multiSellerShops.length}`);
  console.log(`Активні Orders, що порушують target (1 shop + 1 session): ${duplicateShopSessionOrders.length}`);
  console.log(`Активні PickingTask без orderingSessionId: ${activeTasksWithoutSession.length}`);
  console.log(`Дублікати active task у SAME product+group+session: ${duplicateTaskKeys.length}`);
  console.log(`Product+group з active tasks у РІЗНИХ sessions (дозволено, visibility only): ${crossSessionActiveTasks.length}`);
  console.log(`Дублікати OrderingSession group+openDate: ${duplicateSessions.length}\n`);

  if (multiSellerShops.length) {
    console.log('--- Магазини з кількома продавцями (потрібен repair перед unique) ---');
    for (const row of multiSellerShops.slice(0, 100)) {
      console.log(`• ${row.shop} [${row.shopId}]`);
      for (const u of row.sellers) console.log(`    - ${u.telegramId}: ${[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}`);
    }
    console.log('');
  }

  if (duplicateShopSessionOrders.length) {
    console.log('--- 2+ активних Orders одного магазину в одній сесії ---');
    for (const row of duplicateShopSessionOrders.slice(0, 100)) {
      console.log(`• shop=${id(row._id.shopId)} session=${row._id.orderingSessionId} count=${row.count} buyers=${row.buyers.join(',')}`);
    }
    console.log('');
  }

  if (activeTasksWithoutSession.length) {
    console.log('--- Старі active PickingTask без sessionId (НЕ повинні блокувати нові після нового index) ---');
    for (const t of activeTasksWithoutSession.slice(0, 100)) {
      console.log(`• task=${id(t._id)} product=${id(t.productId)} group=${id(t.deliveryGroupId)} status=${t.status} block=${t.blockId}/${t.positionIndex}`);
    }
    console.log('');
  }

  const hardForSessionIsolation = shopsWithoutGroup.length + duplicateTaskKeys.length + duplicateSessions.length;
  console.log(hardForSessionIsolation === 0
    ? '✓ Сесійна ізоляція не має DB-конфліктів, які треба виправити перед деплоєм.'
    : `✗ Знайдено ${hardForSessionIsolation} блокуючих порушень базових session-invariants.`);

  if (multiSellerShops.length || duplicateShopSessionOrders.length) {
    console.log('! Строгий контракт 1 shop = 1 seller = 1 active order/session ще НЕ можна цементувати unique-індексом без repair цих записів.');
  }
}

main()
  .catch((err) => { console.error('AUDIT FAILED:', err); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
