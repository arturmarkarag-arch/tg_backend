'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'seller-catalog-ordering-test-secret';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const app = require('../app');
const { signSession } = require('../utils/jwt');
const User = require('../models/User');
const Product = require('../models/Product');
const Block = require('../models/Block');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const OrderingSession = require('../models/OrderingSession');
const SupplementWave = require('../models/SupplementWave');
const SupplementOffer = require('../models/SupplementOffer');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { getOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { buildOpenClosedTestSchedules } = require('../scripts/helpers/perGroupTestSchedule');

let mongod;
let auth;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const admin = await User.create({
    telegramId: '-980000000001',
    role: 'admin',
    firstName: 'Catalog',
    lastName: 'Test',
  });
  auth = `Bearer ${signSession(admin.telegramId)}`;
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Product.deleteMany({}),
    Block.deleteMany({}),
    DeliveryGroup.deleteMany({}),
    Shop.deleteMany({}),
    OrderingSession.deleteMany({}),
    SupplementWave.deleteMany({}),
    SupplementOffer.deleteMany({}),
    User.deleteMany({ telegramId: { $ne: '-980000000001' } }),
  ]);
});

function get(url) {
  return request(app).get(url).set('Authorization', auth);
}

function createProduct(orderNumber, overrides = {}) {
  return Product.create({
    orderNumber,
    price: orderNumber,
    quantity: 1,
    quantityPerPackage: 1,
    name: `Product ${orderNumber}`,
    status: 'active',
    orderingEnabled: true,
    ...overrides,
  });
}

describe('seller ordinary catalogue HTTP ordering', () => {
  test('returns only eligible products in stable Mongo pages and resolves matching positions', async () => {
    const [third, first, second, pending, disabled, archived, offShelf] = await Promise.all([
      createProduct(30),
      createProduct(10),
      createProduct(20),
      createProduct(5, { status: 'pending' }),
      createProduct(6, { orderingEnabled: false }),
      createProduct(7, { status: 'archived' }),
      createProduct(8),
    ]);
    await Block.create({
      blockId: 1,
      productIds: [third._id, first._id, second._id, pending._id, disabled._id, archived._id],
    });

    const firstPage = await get('/api/v1/products/catalog?limit=2&offset=0').expect(200);
    expect(firstPage.body).toMatchObject({ offset: 0, limit: 2, total: 3, hasMore: true });
    expect(firstPage.body.items.map((item) => item.orderNumber)).toEqual([10, 20]);
    expect(firstPage.body.items[0]).toMatchObject({
      id: String(first._id),
      title: 'Product 10',
      status: 'active',
      orderNumber: 10,
    });

    const secondPage = await get('/api/v1/products/catalog?limit=2&offset=2').expect(200);
    expect(secondPage.body).toMatchObject({ offset: 2, limit: 2, total: 3, hasMore: false });
    expect(secondPage.body.items.map((item) => item.orderNumber)).toEqual([30]);

    const emptyPage = await get('/api/v1/products/catalog?limit=2&offset=50').expect(200);
    expect(emptyPage.body).toMatchObject({ items: [], offset: 50, limit: 2, total: 3, hasMore: false });

    const position = await get(`/api/v1/products/catalog/${second._id}/position`).expect(200);
    expect(position.body).toEqual({ position: 1, total: 3 });

    await get(`/api/v1/products/catalog/${pending._id}/position`).expect(404);
    await get(`/api/v1/products/catalog/${disabled._id}/position`).expect(404);
    await get(`/api/v1/products/catalog/${archived._id}/position`).expect(404);
    await get(`/api/v1/products/catalog/${offShelf._id}/position`).expect(404);
    await get('/api/v1/products/catalog/not-an-object-id/position').expect(400);
  }, 60_000);

  test('preserves cycle cutoff and excludes only active supplements from the same seller session', async () => {
    const { deliveryDay, openSchedule } = buildOpenClosedTestSchedules(new Date());
    const group = await DeliveryGroup.create({
      name: 'Seller catalog group',
      dayOfWeek: deliveryDay,
      orderingSchedule: openSchedule,
    });
    const shop = await Shop.create({
      name: 'Seller catalog shop',
      deliveryGroupId: String(group._id),
      isActive: true,
    });
    const seller = await User.create({
      telegramId: '-980000000002',
      role: 'seller',
      firstName: 'Seller',
      shopId: shop._id,
    });
    const sellerAuth = `Bearer ${signSession(seller.telegramId)}`;
    const orderingSessionId = await getOrCreateSessionId(String(group._id), openSchedule);
    const cutoff = getOrderingWindowOpenAt(openSchedule);
    const beforeCutoff = new Date(cutoff.getTime() - 60_000);
    const afterCutoff = new Date(cutoff.getTime() + 60_000);

    const [ordinary, sameSessionSupplement, postCutoff, withdrawn, otherSession] = await Promise.all([
      createProduct(100, { firstBlockPlacedAt: beforeCutoff }),
      createProduct(110, { firstBlockPlacedAt: beforeCutoff }),
      createProduct(120, { firstBlockPlacedAt: afterCutoff }),
      createProduct(130, { firstBlockPlacedAt: beforeCutoff }),
      createProduct(140, { firstBlockPlacedAt: beforeCutoff }),
    ]);
    await Block.create({
      blockId: 2,
      productIds: [ordinary._id, sameSessionSupplement._id, postCutoff._id, withdrawn._id, otherSession._id],
    });

    const currentWave = await SupplementWave.create({
      deliveryGroupId: String(group._id),
      orderingSessionId,
      publicationKey: `catalog-current-${orderingSessionId}`,
    });
    const previousWave = await SupplementWave.create({
      deliveryGroupId: String(group._id),
      orderingSessionId: 'different-session',
      publicationKey: `catalog-other-${orderingSessionId}`,
    });
    const offerBase = {
      receiptId: new mongoose.Types.ObjectId(),
      deliveryGroupId: String(group._id),
    };
    await SupplementOffer.create([
      {
        ...offerBase,
        receiptItemId: new mongoose.Types.ObjectId(),
        productId: sameSessionSupplement._id,
        waveId: currentWave._id,
        orderingSessionId,
        itemStatus: 'active',
      },
      {
        ...offerBase,
        receiptItemId: new mongoose.Types.ObjectId(),
        productId: withdrawn._id,
        waveId: currentWave._id,
        orderingSessionId,
        itemStatus: 'withdrawn',
      },
      {
        ...offerBase,
        receiptItemId: new mongoose.Types.ObjectId(),
        productId: otherSession._id,
        waveId: previousWave._id,
        orderingSessionId: 'different-session',
        itemStatus: 'active',
      },
    ]);

    const page = await request(app)
      .get('/api/v1/products/catalog?limit=10&offset=0')
      .set('Authorization', sellerAuth)
      .expect(200);
    expect(page.body.items.map((item) => item.orderNumber)).toEqual([100, 130, 140]);
    expect(page.body).toMatchObject({ total: 3, hasMore: false });

    await request(app)
      .get(`/api/v1/products/catalog/${sameSessionSupplement._id}/position`)
      .set('Authorization', sellerAuth)
      .expect(404);
    await request(app)
      .get(`/api/v1/products/catalog/${postCutoff._id}/position`)
      .set('Authorization', sellerAuth)
      .expect(404);
    const otherPosition = await request(app)
      .get(`/api/v1/products/catalog/${otherSession._id}/position`)
      .set('Authorization', sellerAuth)
      .expect(200);
    expect(otherPosition.body).toEqual({ position: 2, total: 3 });
  }, 60_000);
});
