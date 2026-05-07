const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');

let mongoServer;
const TEST_BOT_TOKEN = 'test_bot_token';

function buildInitData(telegramId) {
  const rawData = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: telegramId, first_name: 'Test' }),
  };

  const dataCheckString = Object.keys(rawData)
    .sort()
    .map((key) => `${key}=${rawData[key]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  rawData.hash = hash;

  return new URLSearchParams(rawData).toString();
}

const createTestUser = async (telegramId) => User.findOneAndUpdate(
  { telegramId },
  {
    telegramId,
    firstName: 'Ivan',
    shopName: 'Magazin',
    shopAddress: 'Main St 1',
    shopCity: 'Kyiv',
  },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);

const createTestProduct = async (price = 10) => Product.create({
  price,
  quantity: 10,
  orderNumber: 1,
});

const createOrderRequest = async ({ buyerTelegramId, quantity = 1, price = 10, product } = {}) => {
  await createTestUser(buyerTelegramId);
  const productDoc = product || await createTestProduct(price);
  const initData = buildInitData(buyerTelegramId);
  const response = await request(app)
    .post('/api/orders')
    .send({
      initData,
      items: [{ productId: productDoc._id.toString(), quantity, price }],
    });
  return { response, product: productDoc };
};

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

afterEach(async () => {
  await Order.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Orders API', () => {
  it('creates an order and returns it', async () => {
    const { response } = await createOrderRequest({ buyerTelegramId: '12345', quantity: 2, price: 10 });

    expect(response.status).toBe(201);
    expect(response.body.buyerTelegramId).toBe('12345');
    expect(response.body.totalPrice).toBe(20);
  });

  it('rejects order creation when initData does not match buyerTelegramId', async () => {
    await createTestUser('12345');
    await createTestUser('54321');
    const product = await createTestProduct(10);
    const invalidInitData = buildInitData('54321');

    const response = await request(app)
      .post('/api/orders')
      .send({
        initData: invalidInitData,
        buyerTelegramId: '12345',
        items: [{ productId: product._id.toString(), quantity: 1, price: 10 }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('buyerTelegramId does not match authenticated user');
  });

  it('merges new items into an existing active order within 3 days', async () => {
    const product = await createTestProduct(10);
    await createOrderRequest({ buyerTelegramId: '12345', quantity: 2, price: 10, product });

    const { response: mergedResponse } = await createOrderRequest({ buyerTelegramId: '12345', quantity: 3, price: 10, product });

    expect(mergedResponse.status).toBe(201);
    expect(mergedResponse.body._id).toBeDefined();
    expect(mergedResponse.body.items).toHaveLength(1);
    expect(mergedResponse.body.items[0].quantity).toBe(5);
    expect(mergedResponse.body.totalPrice).toBe(50);
    expect(mergedResponse.body.status).toBe('in_progress');

    const orders = await Order.find({ buyerTelegramId: '12345' });
    expect(orders).toHaveLength(1);
  });

  it('returns orders with buyer details when user exists', async () => {
    await createTestUser('12345');
    const { response: createResponse } = await createOrderRequest({ buyerTelegramId: '12345', quantity: 1, price: 20 });

    expect(createResponse.status).toBe(201);

    const listResponse = await request(app).get('/api/orders').query({ initData: buildInitData('12345') });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.orders[0].buyer).toBeDefined();
    expect(listResponse.body.orders[0].buyer.shopName).toBe('Magazin');
    expect(listResponse.body.orders[0].buyer.shopCity).toBe('Kyiv');
  });

  it('returns paginated response', async () => {
    const product = await createTestProduct(10);
    for (let i = 0; i < 5; i++) {
      await createOrderRequest({ buyerTelegramId: `buyer${i}`, quantity: 1, price: 10, product });
    }

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('buyer0'), page: 1, pageSize: 2 });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.pageCount).toBe(3);
  });

  it('returns second page of orders', async () => {
    const product = await createTestProduct(10);
    for (let i = 0; i < 5; i++) {
      await createOrderRequest({ buyerTelegramId: `buyer${i}`, quantity: 1, price: 10, product });
    }

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('buyer0'), page: 2, pageSize: 2 });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.page).toBe(2);
  });

  it('filters orders by status', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    await createTestUser('admin1');
    const confirmed = await createOrderRequest({ buyerTelegramId: '222', quantity: 2, price: 20, product });
    await User.updateOne({ telegramId: 'admin1' }, { role: 'admin' }, { upsert: true });
    await request(app)
      .patch(`/api/orders/${confirmed.response.body._id}`)
      .send({ initData: buildInitData('admin1'), status: 'confirmed' });

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('111'), status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].status).toBe('confirmed');
  });

  it('filters orders by buyerTelegramId', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: 'user111', quantity: 1, price: 10, product });
    await createOrderRequest({ buyerTelegramId: 'user222', quantity: 2, price: 20, product });

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('user111'), buyerTelegramId: 'user111', status: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].buyerTelegramId).toBe('user111');
  });

  it('excludes cancelled orders by default', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const toCancel = await createOrderRequest({ buyerTelegramId: '222', quantity: 1, price: 10, product });
    await request(app)
      .patch(`/api/orders/${toCancel.response.body._id}`)
      .send({ initData: buildInitData('222'), status: 'cancelled' });

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('111') });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].buyerTelegramId).toBe('111');
  });

  it('excludes expired orders by default', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const toExpire = await createOrderRequest({ buyerTelegramId: '222', quantity: 1, price: 10, product });
    await request(app)
      .patch(`/api/orders/${toExpire.response.body._id}`)
      .send({ initData: buildInitData('222'), status: 'expired' });

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('111') });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].buyerTelegramId).toBe('111');
  });

  it('returns all orders including cancelled with status=all', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const toCancel = await createOrderRequest({ buyerTelegramId: '222', quantity: 1, price: 10, product });
    await request(app)
      .patch(`/api/orders/${toCancel.response.body._id}`)
      .send({ initData: buildInitData('222'), status: 'cancelled' });

    const res = await request(app).get('/api/orders').query({ initData: buildInitData('111'), status: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
  });

  it('updates order status via PATCH', async () => {
    const product = await createTestProduct(10);

    const { response: created } = await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });

    const res = await request(app)
      .patch(`/api/orders/${created.body._id}`)
      .send({ initData: buildInitData('111'), status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('denies PATCH when user is not owner or staff', async () => {
    const product = await createTestProduct(10);
    const { response: created } = await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    await createTestUser('222');

    const res = await request(app)
      .patch(`/api/orders/${created.body._id}`)
      .send({ initData: buildInitData('222'), status: 'cancelled' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You do not have permission to modify this order');
  });

  it('returns 404 when updating non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    await createTestUser('111');
    const res = await request(app)
      .patch(`/api/orders/${fakeId}`)
      .send({ initData: buildInitData('111'), status: 'confirmed' });

    expect(res.status).toBe(404);
  });

  it('gets a single order by id', async () => {
    const product = await createTestProduct(10);

    const { response: created } = await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });

    const res = await request(app)
      .get(`/api/orders/${created.body._id}`)
      .query({ initData: buildInitData('111') });

    expect(res.status).toBe(200);
    expect(res.body.buyerTelegramId).toBe('111');
  });

  it('returns 404 for non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    await createTestUser('111');
    const res = await request(app)
      .get(`/api/orders/${fakeId}`)
      .query({ initData: buildInitData('111') });
    expect(res.status).toBe(404);
  });
});
