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
  const receipt = await Receipt.create({
    receiptNumber: `REC-CROSS-${seq}`,
    status: 'completed',
    completedAt: new Date(),
    type: 'regular',
    createdBy: admin.telegramId,
  });
  const product = await Product.create({
    orderNumber: 1000 + seq,
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

  it('blocks unconfirm, delete and commercial edit once deferred publication was requested', async () => {
    const { receipt, item, product } = await seedConfirmed({ supplement: true, publishRequested: true, warehouse: false });

    const unconfirm = await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`);
    expect(unconfirm.status).toBe(409);
    expect(unconfirm.body.error).toBe('receipt_item_in_use');

    const remove = await del(`/api/receipts/${receipt._id}/items/${item._id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toBe('receipt_item_in_use');

    const price = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '3');
    expect(price.status).toBe(409);
    expect(price.body.error).toBe('receipt_item_in_use');

    const [freshItem, freshProduct] = await Promise.all([
      ReceiptItem.findById(item._id).lean(),
      Product.findById(product._id).lean(),
    ]);
    expect(freshItem.status).toBe('confirmed');
    expect(freshItem.supplementPublishRequestedAt).toBeTruthy();
    expect(freshItem.price).toBe(2);
    expect(freshProduct.price).toBe(2);
  });

  it.each(['open', 'frozen', 'completed'])('blocks unconfirm/delete/commercial edit for %s supplement offer even with zero requests', async (status) => {
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
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('receipt_item_in_use');
    expect(await SupplementRequest.countDocuments({})).toBe(0);
  });

  it('block membership freezes price/original-photo corrections through the receipt', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await Block.create({ blockId: 77, productIds: [product._id] });

    const price = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(price.status).toBe(409);
    expect(price.body.error).toBe('receipt_item_in_use');

    const photo = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('originalFilename', 'replacement.jpg');
    expect(photo.status).toBe(409);
    expect(photo.body.error).toBe('receipt_item_in_use');
  });

  it('order usage alone freezes commercial edits and destructive rollback', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await Order.create({
      orderNumber: 800000 + seq,
      buyerTelegramId: '-991',
      status: 'new',
      items: [{ productId: product._id, name: 'Cross test product', price: 2, quantity: 1 }],
      totalPrice: 2,
    });

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('qtyPerPackage', '24');
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('receipt_item_in_use');
    expect((await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status).toBe(409);
    expect((await del(`/api/receipts/${receipt._id}/items/${item._id}`)).status).toBe(409);
  });

  it('picking usage alone freezes commercial edits and destructive rollback', async () => {
    const { receipt, item, product } = await seedConfirmed();
    await PickingTask.create({
      productId: product._id,
      deliveryGroupId: 'g-cross',
      blockId: 99,
      positionIndex: 1,
      status: 'pending',
    });

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('receipt_item_in_use');
    expect((await post(`/api/receipts/${receipt._id}/items/${item._id}/unconfirm`)).status).toBe(409);
    expect((await del(`/api/receipts/${receipt._id}/items/${item._id}`)).status).toBe(409);
  });

  it('archived warehouse product also freezes receipt rollback and commercial correction', async () => {
    const { receipt, item, product } = await seedConfirmed();
    product.status = 'archived';
    await product.save();

    const edit = await patch(`/api/receipts/${receipt._id}/items/${item._id}`).field('price', '4');
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('receipt_item_in_use');
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

  it('one ready item may publish independently into two current delivery sessions', async () => {
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
    expect(Number(a.body.selectedCount || 0)).toBe(1);
    expect(Number(b.body.selectedCount || 0)).toBe(1);

    const fresh = await ReceiptItem.findById(item._id).lean();
    expect(fresh.supplementPublishRequestedAt).toBeTruthy();
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(2);
    expect(await SupplementWave.countDocuments({})).toBe(2);

    const retry = await publishToGroup(groupA);
    expect(retry.status).toBe(200);
    expect(retry.body.selectedCount).toBe(0);
    expect(await SupplementOffer.countDocuments({ receiptItemId: item._id })).toBe(2);
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
