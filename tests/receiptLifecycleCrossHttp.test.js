'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'receipt-cross-http-test-secret';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const app = require('../app');
const { signSession } = require('../utils/jwt');
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
const SupplementWave = require('../models/SupplementWave');
const SupplementRequest = require('../models/SupplementRequest');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const OrderingSession = require('../models/OrderingSession');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { buildOpenClosedTestSchedules } = require('../scripts/helpers/perGroupTestSchedule');

let mongod;
let admin;
let worker;
let auth;
let workerAuth;
let seq = 0;
let seedSeq = 0;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongod.getUri());
  admin = await User.create({ telegramId: '-990000000001', role: 'admin', firstName: 'Receipt', lastName: 'Guard' });
  worker = await User.create({ telegramId: '-990000000002', role: 'warehouse', firstName: 'Other', lastName: 'Worker' });
  auth = `Bearer ${signSession(admin.telegramId)}`;
  workerAuth = `Bearer ${signSession(worker.telegramId)}`;
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  seq += 1;
  await Promise.all([
    Receipt.deleteMany({}),
    ReceiptItem.deleteMany({}),
    Product.deleteMany({}),
    ShopProduct.deleteMany({}),
    ProductVector.deleteMany({}),
    Block.deleteMany({}),
    Order.deleteMany({}),
    PickingTask.deleteMany({}),
    SupplementOffer.deleteMany({}),
    SupplementRequest.deleteMany({}),
    SupplementWave.deleteMany({}),
    OrderingSession.deleteMany({}),
    Shop.deleteMany({}),
    DeliveryGroup.deleteMany({}),
  ]);
});

async function seedConfirmed({ supplement = false, publishRequested = false, warehouse = true } = {}) {
  const localSeed = ++seedSeq;
  const receipt = await Receipt.create({
    receiptNumber: `REC-CROSS-${seq}-${localSeed}`,
    status: 'completed',
    completedAt: new Date(),
    type: 'regular',
    createdBy: admin.telegramId,
  });
  const product = await Product.create({
    orderNumber: 100000 + localSeed,
    price: 2,
    quantity: 0,
    quantityPerPackage: 12,
    name: 'Cross test product',
    brand: 'Cross test product',
    status: 'pending',
    source: 'receipt',
    orderingEnabled: warehouse,
    imageUrls: ['https://example.test/product.jpg'],
    imageNames: ['product.jpg'],
    originalImageUrl: 'https://example.test/original.jpg',
  });
  const routing = {
    warehouse,
    mandatory: false,
    supplement,
    mayNotReachAllShops: false,
    supplementDeliveryGroupId: supplement && publishRequested ? 'g-cross' : null,
  };
  const item = await ReceiptItem.create({
    receiptId: receipt._id,
    createdBy: admin.telegramId,
    status: 'confirmed',
    stockApplied: true,
    destination: 'shelf',
    routingVersion: 1,
    routing,
    supplementBatchVersion: supplement ? 2 : 0,
    supplementPublishRequestedAt: publishRequested ? new Date() : null,
    photoUrl: 'https://example.test/product.jpg',
    photoName: 'product.jpg',
    originalPhotoUrl: 'https://example.test/original.jpg',
    totalQty: 12,
    price: 2,
    qtyPerPackage: 12,
    createdProductId: product._id,
  });
  product.receiptItemId = item._id;
  await product.save();
  return { receipt, item, product };
}


async function createClosedGroup(name) {
  const { deliveryDay, closedSchedule } = buildOpenClosedTestSchedules(new Date());
  const group = await DeliveryGroup.create({
    name,
    dayOfWeek: deliveryDay,
    orderingSchedule: closedSchedule,
  });
  // The production server proactively materialises current sessions. The HTTP
  // test does the same explicitly because app.js (unlike index.js) does not run
  // schedulers.
  group.orderingSessionId = await getOrCreateSessionId(String(group._id), closedSchedule);
  await Shop.create({
    name: `${name} Shop`,
    deliveryGroupId: String(group._id),
    isActive: true,
  });
  return group;
}

function publishToGroup(group) {
  return post(`/api/receipts/supplement-batches/${group._id}/publish`)
    .send({ orderingSessionId: String(group.orderingSessionId) });
}

function post(url) {
  return request(app).post(url).set('Authorization', auth);
}
function del(url) {
  return request(app).delete(url).set('Authorization', auth);
}
function patch(url) {
  return request(app).patch(url).set('Authorization', auth);
}
function workerPatch(url) {
  return request(app).patch(url).set('Authorization', workerAuth);
}
function workerPost(url) {
  return request(app).post(url).set('Authorization', workerAuth);
}

async function createMirror(product) {
  return ShopProduct.create({
    linkedProductId: product._id,
    name: product.name,
    price: product.price,
    quantityPerPackage: product.quantityPerPackage,
    imageUrl: product.imageUrls?.[0] || '',
    originalImageUrl: product.originalImageUrl || '',
    source: 'receive',
  });
}

describe('receipt lifecycle HTTP cross guards', () => {
  it('exposes a receiving link only for products backed by a real ReceiptItem', async () => {
    const { item, product } = await seedConfirmed();
    const direct = await Product.create({
      orderNumber: 900000 + seedSeq,
      price: 1,
      quantity: 1,
      name: 'Direct product',
      status: 'active',
      source: 'manual',
      imageUrls: ['https://example.test/direct.jpg'],
    });
    await Block.create({ blockId: 901, productIds: [product._id, direct._id] });

    const board = await request(app).get('/api/blocks/901').set('Authorization', auth);
    expect(board.status).toBe(200);
    const byId = new Map(board.body.productIds.map((row) => [String(row._id), row]));
    expect(String(byId.get(String(product._id)).receiptItemId)).toBe(String(item._id));
    expect(byId.get(String(direct._id)).receiptItemId).toBeNull();

    const linkedContext = await request(app)
      .get(`/api/receipts/product-context/${product._id}`)
      .set('Authorization', auth);
    expect(linkedContext.status).toBe(200);
    expect(String(linkedContext.body.item._id)).toBe(String(item._id));

    const directContext = await request(app)
      .get(`/api/receipts/product-context/${direct._id}`)
      .set('Authorization', auth);
    expect(directContext.status).toBe(404);
    expect(directContext.body.error).toBe('receipt_item_not_found');
  });

  it('allows rollback before supplement publication starts', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const res = await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(await Product.exists({ _id: product._id })).toBeNull();
  });

  it('can reassign a confirmed supplement before publication by explicit unconfirm -> routing -> confirm', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });

    const rollback = await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(rollback.status).toBe(200);
    expect(await Product.exists({ _id: product._id })).toBeNull();

    const reroute = await patch(`/api/receipts/${receipt._id}/items/${item._id}/routing`).send({
      warehouse: true,
      mandatory: false,
      supplement: false,
    });
    expect(reroute.status).toBe(200);
    expect(reroute.body.routing.warehouse).toBe(true);
    expect(reroute.body.routing.supplement).toBe(false);

    const reconfirm = await post(`/api/receipts/${receipt._id}/items/${item._id}/confirm`);
    expect(reconfirm.status).toBe(200);
    expect(reconfirm.body.status).toBe('confirmed');
    expect(reconfirm.body.routing.warehouse).toBe(true);
    expect(reconfirm.body.routing.supplement).toBe(false);
    expect(await Product.countDocuments({ receiptItemId: item._id })).toBe(1);
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(0);
  });

  it('clean confirmed item still propagates commercial corrections to Product and mirror before downstream use', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await createMirror(product);

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`)
      .field('price', '3.5')
      .field('qtyPerPackage', '24');
    expect(edit.status).toBe(200);

    const [freshItem, freshProduct, mirror] = await Promise.all([
      ReceiptItem.findById(item._id).lean(),
      Product.findById(product._id).lean(),
      ShopProduct.findOne({ linkedProductId: product._id }).lean(),
    ]);
    expect(freshItem.price).toBe(3.5);
    expect(freshItem.qtyPerPackage).toBe(24);
    expect(freshProduct.price).toBe(3.5);
    expect(freshProduct.quantityPerPackage).toBe(24);
    expect(mirror.price).toBe(3.5);
    expect(mirror.quantityPerPackage).toBe(24);
  });

  it('non-owner may prepare shared commercial fields but cannot route or unconfirm the item', async () => {
    const { receipt, item } = await seedConfirmed();

    const sharedEdit = await workerPatch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '2.5');
    expect(sharedEdit.status).toBe(200);

    const route = await workerPatch(`/api/receipts/${receipt._id}/items/${item._id}/routing`).send({
      warehouse: true, mandatory: false, supplement: false,
    });
    expect(route.status).toBe(403);
    expect(route.body.error).toBe('receipt_item_forbidden_edit');

    const rollback = await workerPost(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(rollback.status).toBe(403);
    expect(rollback.body.error).toBe('receipt_item_forbidden_confirm');
  });

  it('blocks destructive rollback but keeps commercial metadata editable after deferred publication', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });

    const unconfirm = await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(unconfirm.status).toBe(409);
    expect(unconfirm.body.error).toBe('receipt_item_in_use');

    const remove = await del(`/api/receipts/${receipt._id}/items/${item._id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toBe('receipt_item_in_use');

    const price = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '3');
    expect(price.status).toBe(200);

    const [freshItem, freshProduct] = await Promise.all([
      ReceiptItem.findById(item._id).lean(),
      Product.findById(product._id).lean(),
    ]);
    expect(freshItem.status).toBe('confirmed');
    expect(freshItem.supplementPublishRequestedAt).toBeTruthy();
    expect(freshItem.price).toBe(3);
    expect(freshProduct.price).toBe(3);
  });

  it.each(['open', 'frozen', 'completed'])('blocks unconfirm/delete but allows metadata correction for %s supplement offer with zero requests', async (status) => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    await SupplementOffer.create({
      receiptId: receipt._id,
      receiptItemId: item._id,
      productId: product._id,
      deliveryGroupId: 'g-cross',
      status,
    });

    const unconfirm = await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(unconfirm.status).toBe(409);
    expect(unconfirm.body.error).toBe('receipt_item_in_use');

    const remove = await del(`/api/receipts/${receipt._id}/items/${item._id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toBe('receipt_item_in_use');

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('qtyPerPackage', '24');
    expect(edit.status).toBe(200);
    expect((await ReceiptItem.findById(item._id).lean()).qtyPerPackage).toBe(24);
    expect(await SupplementRequest.countDocuments({})).toBe(0);
  });

  it('block membership blocks rollback but keeps commercial metadata corrections available', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await Block.create({ blockId: 77, productIds: [product._id] });

    const price = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(price.status).toBe(200);
  });

  it('order usage blocks destructive rollback but permits canonical metadata correction', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await Order.create({
      orderNumber: 800000 + seq,
      buyerTelegramId: '-991',
      status: 'new',
      items: [{ productId: product._id, name: 'Cross test product', price: 2, quantity: 1 }],
      totalPrice: 2,
    });

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('qtyPerPackage', '24');
    expect(edit.status).toBe(200);
    expect((await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status).toBe(409);
    expect((await del(`/api/receipts/${receipt._id}/items/${item._id}`)).status).toBe(409);
  });

  it('picking usage blocks destructive rollback but permits canonical metadata correction', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await PickingTask.create({
      productId: product._id,
      deliveryGroupId: 'g-cross',
      blockId: 99,
      positionIndex: 1,
      status: 'pending',
    });

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(edit.status).toBe(200);
    expect((await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status).toBe(409);
    expect((await del(`/api/receipts/${receipt._id}/items/${item._id}`)).status).toBe(409);
  });

  it('archived warehouse product blocks rollback but still accepts metadata correction', async () => {
    const { receipt, item, product } = await seedConfirmed();
    product.status = 'archived';
    await product.save();

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(edit.status).toBe(200);
    expect((await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status).toBe(409);
  });

  it('still allows cosmetic comment/label metadata after the process started', async () => {
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    const res = await patch(`/api/receipts/${receipt._id}/items/${item._id}`)
      .field('photoMeta', JSON.stringify({
        comments: [{ id: 'c1', text: 'Магніти', pos: { x: 0.5, y: 0.5 } }],
        pricePos: { x: 0.1, y: 0.1 },
        qtyPos: { x: 0.1, y: 0.9 },
      }));
    expect(res.status).toBe(200);
    const fresh = await ReceiptItem.findById(item._id).lean();
    expect(fresh.photoMeta.comments[0].text).toBe('Магніти');
  });

  it('modern supplement-only publication creates a Wave item without requiring a warehouse Product', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    // Simulate the canonical standalone state created by current routing: no
    // warehouse Product exists because warehouse=false.
    await Product.deleteOne({ _id: product._id });
    await ReceiptItem.updateOne({ _id: item._id }, { $set: { createdProductId: null } });

    const group = await createClosedGroup(`Cross Standalone ${seq}`);
    const publish = await publishToGroup(group);
    expect(publish.status).toBe(200);
    expect(publish.body.selectedCount).toBe(1);

    const [wave, offer] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(group.orderingSessionId) }).lean(),
      SupplementOffer.findOne({ receiptItemId: item._id }).lean(),
    ]);
    expect(wave).toBeTruthy();
    expect(String(wave.deliveryGroupId)).toBe(String(group._id));
    expect(offer).toBeTruthy();
    expect(offer.productId).toBeNull();
    expect(offer.sourceSnapshot).toBeTruthy();
  });

  it('one ready item can open in only one delivery session even under concurrent target publishes', async () => {
    const { item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [groupA, groupB] = await Promise.all([
      createClosedGroup('Cross A'),
      createClosedGroup('Cross B'),
    ]);

    const [a, b] = await Promise.all([
      publishToGroup(groupA),
      publishToGroup(groupB),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(Number(a.body.selectedCount || 0) + Number(b.body.selectedCount || 0)).toBe(1);

    const fresh = await ReceiptItem.findById(item._id).lean();
    expect(fresh.supplementPublishRequestedAt).toBeTruthy();
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(1);
    expect(await SupplementWave.countDocuments({})).toBe(1);

    const retry = await publishToGroup(groupA);
    expect(retry.status).toBe(200);
    expect(retry.body.selectedCount).toBe(0);
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(1);
  });

  it('cancel -> complete-by-cancellation -> edit -> republish reopens only the exact current session and starts clean', async () => {
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const group = await createClosedGroup(`Cross Repeat ${seq}`);

    const first = await publishToGroup(group);
    expect(first.status).toBe(200);
    expect(Number(first.body.selectedCount || 0)).toBe(1);

    const [wave, offer, shop] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(group.orderingSessionId) }).lean(),
      SupplementOffer.findOne({ receiptItemId: item._id, orderingSessionId: String(group.orderingSessionId) }).lean(),
      Shop.findOne({ deliveryGroupId: String(group._id), isActive: true }).lean(),
    ]);
    expect(wave).toBeTruthy();
    expect(offer).toBeTruthy();
    expect(shop).toBeTruthy();

    const oldRequest = await SupplementRequest.create({
      waveId: wave._id,
      orderingSessionId: String(group.orderingSessionId),
      offerId: offer._id,
      revision: 1,
      shopId: shop._id,
      shopName: shop.name,
      deliveryGroupId: String(group._id),
      quantity: 3,
      status: 'active',
      createdBy: admin.telegramId,
    });

    // Simulate the ordinary part already being done: cancellation of the final
    // supplement item is now allowed to make the delivery session terminal.
    await OrderingSession.updateOne(
      { _id: group.orderingSessionId },
      { $set: { pickingStatus: 'confirmed', pickingConfirmedAt: new Date() } },
    );

    const cancelled = await post(`/api/supplement/offers/${offer._id}/cancel`).send({ reason: 'test_restart' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await OrderingSession.findById(group.orderingSessionId).lean()).pickingStatus).toBe('completed');

    const cancelledRequest = await SupplementRequest.findById(oldRequest._id).lean();
    expect(cancelledRequest.status).toBe('cancelled');
    expect(cancelledRequest.revision).toBe(1);

    // Terminal modern revision owns its old snapshot, so future metadata may change.
    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '3.5');
    expect(edit.status).toBe(200);

    const repeat = await publishToGroup(group);
    expect(repeat.status).toBe(200);
    expect(Number(repeat.body.selectedCount || 0)).toBe(1);

    const [sameWave, restartedOffer, reopenedSession] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(group.orderingSessionId), mergedIntoWaveId: null }).lean(),
      SupplementOffer.findById(offer._id).lean(),
      OrderingSession.findById(group.orderingSessionId).lean(),
    ]);
    expect(String(sameWave._id)).toBe(String(wave._id));
    expect(await SupplementWave.countDocuments({ orderingSessionId: String(group.orderingSessionId), mergedIntoWaveId: null })).toBe(1);
    expect(restartedOffer.revision).toBe(2);
    expect(restartedOffer.status).toBe('open');
    expect(Number(restartedOffer.sourceSnapshot?.price || 0)).toBe(3.5);
    expect(await SupplementRequest.countDocuments({ offerId: offer._id, revision: 2 })).toBe(0);
    expect((await SupplementRequest.findById(oldRequest._id).lean()).status).toBe('cancelled');
    expect(reopenedSession.pickingStatus).toBe('in_progress');
  });

  it('a FROZEN cancellation releases the ReceiptItem for another target', async () => {
    const { item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [groupA, groupB] = await Promise.all([
      createClosedGroup(`Cross Frozen A ${seq}`),
      createClosedGroup(`Cross Frozen B ${seq}`),
    ]);

    const first = await publishToGroup(groupA);
    expect(first.status).toBe(200);
    expect(Number(first.body.selectedCount || 0)).toBe(1);

    const [wave, offer, shop] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(groupA.orderingSessionId) }).lean(),
      SupplementOffer.findOne({ receiptItemId: item._id, orderingSessionId: String(groupA.orderingSessionId) }).lean(),
      Shop.findOne({ deliveryGroupId: String(groupA._id), isActive: true }).lean(),
    ]);
    expect(wave).toBeTruthy();
    expect(offer).toBeTruthy();
    expect(shop).toBeTruthy();
    await SupplementRequest.create({
      waveId: wave._id,
      orderingSessionId: String(groupA.orderingSessionId),
      offerId: offer._id,
      revision: offer.revision,
      shopId: shop._id,
      shopName: shop.name,
      deliveryGroupId: String(groupA._id),
      quantity: 1,
      status: 'active',
      createdBy: admin.telegramId,
    });

    const freeze = await post(`/api/supplement/waves/${wave._id}/freeze`);
    expect(freeze.status).toBe(200);
    expect((await SupplementOffer.findById(offer._id).lean()).status).toBe('frozen');

    const cancelled = await post(`/api/supplement/offers/${offer._id}/cancel`).send({ reason: 'terminal_after_freeze' });
    expect(cancelled.status).toBe(200);
    const terminal = await SupplementOffer.findById(offer._id).lean();
    expect(terminal.status).toBe('cancelled');
    expect(terminal.frozenAt).toBeTruthy();

    const second = await publishToGroup(groupB);
    expect(second.status).toBe(200);
    expect(Number(second.body.selectedCount || 0)).toBe(1);
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(2);
    expect(await SupplementOffer.findOne({
      receiptItemId: item._id,
      orderingSessionId: String(groupB.orderingSessionId),
      status: 'open',
    }).lean()).toBeTruthy();

    const pending = await request(app)
      .get('/api/receipts/supplement-batches/pending')
      .set('Authorization', auth);
    expect(pending.status).toBe(200);
    expect(Math.max(...pending.body.targets.map((target) => Number(target.readyCount || 0)), 0)).toBe(0);
  });

  it('a zero-request item is released after freeze and may target another group', async () => {
    const { item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [groupA, groupB] = await Promise.all([
      createClosedGroup(`Cross Empty A ${seq}`),
      createClosedGroup(`Cross Empty B ${seq}`),
    ]);

    const first = await publishToGroup(groupA);
    expect(first.status).toBe(200);
    const [wave, offer] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(groupA.orderingSessionId) }).lean(),
      SupplementOffer.findOne({ receiptItemId: item._id, orderingSessionId: String(groupA.orderingSessionId) }).lean(),
    ]);

    const freeze = await post(`/api/supplement/waves/${wave._id}/freeze`);
    expect(freeze.status).toBe(200);
    const released = await SupplementOffer.findById(offer._id).lean();
    expect(released.status).toBe('cancelled');
    expect(released.frozenAt).toBeTruthy();
    expect(released.completedAt).toBeFalsy();
    expect(released.cancelReason).toBe('no_requests');

    const second = await publishToGroup(groupB);
    expect(second.status).toBe(200);
    expect(Number(second.body.selectedCount || 0)).toBe(1);
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(2);
  });

  it('an old OPEN cancellation cannot reopen its session after the item was retargeted elsewhere', async () => {
    const firstItem = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const [groupA, groupB] = await Promise.all([
      createClosedGroup(`Cross Retarget A ${seq}`),
      createClosedGroup(`Cross Retarget B ${seq}`),
    ]);

    expect((await publishToGroup(groupA)).body.selectedCount).toBe(1);
    const offerA = await SupplementOffer.findOne({
      receiptItemId: firstItem.item._id,
      orderingSessionId: String(groupA.orderingSessionId),
    }).lean();
    await OrderingSession.updateOne(
      { _id: groupA.orderingSessionId },
      { $set: { pickingStatus: 'confirmed', pickingConfirmedAt: new Date() } },
    );
    expect((await post(`/api/supplement/offers/${offerA._id}/cancel`).send({ reason: 'wrong_group' })).status).toBe(200);
    expect((await OrderingSession.findById(groupA.orderingSessionId).lean()).pickingStatus).toBe('completed');

    const retarget = await publishToGroup(groupB);
    expect(retarget.status).toBe(200);
    expect(Number(retarget.body.selectedCount || 0)).toBe(1);

    await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const staleReopen = await publishToGroup(groupA);
    expect(staleReopen.status).toBe(409);
    expect(staleReopen.body.error).toBe('supplement_target_session_completed');
  });

  it('successful completed supplement state cannot reopen the delivery session', async () => {
    const { item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const group = await createClosedGroup(`Cross Completed Closed ${seq}`);

    const first = await publishToGroup(group);
    expect(first.status).toBe(200);
    expect(Number(first.body.selectedCount || 0)).toBe(1);

    const offer = await SupplementOffer.findOne({
      receiptItemId: item._id,
      orderingSessionId: String(group.orderingSessionId),
    });
    expect(offer).toBeTruthy();
    offer.status = 'completed';
    offer.completedAt = new Date();
    await offer.save();
    await OrderingSession.updateOne(
      { _id: group.orderingSessionId },
      { $set: { pickingStatus: 'completed', pickingCompletedAt: new Date() } },
    );

    const repeat = await publishToGroup(group);
    expect(repeat.status).toBe(409);
    expect(repeat.body.error).toBe('supplement_target_session_completed');
    expect((await OrderingSession.findById(group.orderingSessionId).lean()).pickingStatus).toBe('completed');
    expect((await SupplementOffer.findById(offer._id).lean()).revision).toBe(1);
  });

  it('freezing existing items does not create a second container when a new product arrives later', async () => {
    const firstItem = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const group = await createClosedGroup(`Cross Add After Freeze ${seq}`);
    const firstPublish = await publishToGroup(group);
    expect(firstPublish.status).toBe(200);
    expect(Number(firstPublish.body.selectedCount || 0)).toBe(1);

    const [wave, firstOffer, shop] = await Promise.all([
      SupplementWave.findOne({ orderingSessionId: String(group.orderingSessionId) }).lean(),
      SupplementOffer.findOne({ receiptItemId: firstItem.item._id, orderingSessionId: String(group.orderingSessionId) }).lean(),
      Shop.findOne({ deliveryGroupId: String(group._id), isActive: true }).lean(),
    ]);
    await SupplementRequest.create({
      waveId: wave._id,
      orderingSessionId: String(group.orderingSessionId),
      offerId: firstOffer._id,
      revision: 1,
      shopId: shop._id,
      shopName: shop.name,
      deliveryGroupId: String(group._id),
      quantity: 2,
      status: 'active',
      createdBy: admin.telegramId,
    });

    const freeze = await post(`/api/supplement/waves/${wave._id}/freeze`);
    expect(freeze.status).toBe(200);
    expect((await SupplementOffer.findById(firstOffer._id).lean()).status).toBe('frozen');

    const secondItem = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const secondPublish = await publishToGroup(group);
    expect(secondPublish.status).toBe(200);
    expect(Number(secondPublish.body.selectedCount || 0)).toBe(1);

    const [oldAfter, newOffer] = await Promise.all([
      SupplementOffer.findById(firstOffer._id).lean(),
      SupplementOffer.findOne({ receiptItemId: secondItem.item._id, orderingSessionId: String(group.orderingSessionId) }).lean(),
    ]);
    expect(oldAfter.status).toBe('frozen');
    expect(newOffer.status).toBe('open');
    expect(String(newOffer.waveId)).toBe(String(wave._id));
    expect(await SupplementWave.countDocuments({ orderingSessionId: String(group.orderingSessionId), mergedIntoWaveId: null })).toBe(1);
  });

  it('publish vs unconfirm race has only two valid outcomes and never leaves a split state', async () => {
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const group = await createClosedGroup(`Cross Race U ${seq}`);

    const [publish, rollback] = await Promise.all([
      publishToGroup(group),
      post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`),
    ]);

    expect(publish.status).toBe(200);
    expect([200, 409]).toContain(rollback.status);
    const fresh = await ReceiptItem.findById(item._id).lean();
    expect(fresh).toBeTruthy();

    if (rollback.status === 200) {
      expect(publish.body.selectedCount).toBe(0);
      expect(fresh.status).toBe('draft');
      expect(fresh.supplementPublishRequestedAt).toBeNull();
      expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(0);
    } else {
      expect(rollback.body.error).toBe('receipt_item_in_use');
      expect(publish.body.selectedCount).toBe(1);
      expect(fresh.status).toBe('confirmed');
      expect(fresh.routing.supplement).toBe(true);
      expect(fresh.supplementPublishRequestedAt).toBeTruthy();
      expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(1);
    }
  });

  it('publish vs delete race cannot publish a deleted item or delete a published item', async () => {
    const { receipt, item } = await seedConfirmed({ supplement: true, publishRequested: false, warehouse: false });
    const group = await createClosedGroup(`Cross Race D ${seq}`);

    const [publish, remove] = await Promise.all([
      publishToGroup(group),
      del(`/api/receipts/${receipt._id}/items/${item._id}`),
    ]);

    expect(publish.status).toBe(200);
    expect([200, 409]).toContain(remove.status);
    const fresh = await ReceiptItem.findById(item._id).lean();

    if (remove.status === 200) {
      expect(publish.body.selectedCount).toBe(0);
      expect(fresh).toBeNull();
      expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(0);
    } else {
      expect(remove.body.error).toBe('receipt_item_in_use');
      expect(publish.body.selectedCount).toBe(1);
      expect(fresh.status).toBe('confirmed');
      expect(fresh.routing.supplement).toBe(true);
      expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(1);
    }
  });

  it('confirmed routing cannot be reassigned, while additive warehouse remainder stays allowed', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });
    const offer = await SupplementOffer.create({
      receiptId: receipt._id,
      receiptItemId: item._id,
      productId: product._id,
      deliveryGroupId: 'g-cross',
      status: 'open',
    });

    const reroute = await patch(`/api/receipts/${receipt._id}/items/${item._id}/routing`).send({
      warehouse: false,
      mandatory: true,
      supplement: false,
    });
    expect(reroute.status).toBe(409);
    expect(reroute.body.error).toBe('receipt_route_locked');

    const remainder = await post(`/api/receipts/${receipt._id}/items/${item._id}/add-warehouse-remainder`);
    expect(remainder.status).toBe(200);
    expect(remainder.body.routing.warehouse).toBe(true);
    expect(remainder.body.routing.supplement).toBe(true);

    const freshItem = await ReceiptItem.findById(item._id).lean();
    expect(String(freshItem.routing.supplementDeliveryGroupId)).toBe('g-cross');
    expect(freshItem.supplementPublishRequestedAt).toBeTruthy();
    expect(await SupplementOffer.exists({ _id: offer._id })).toBeTruthy();
  });
});
