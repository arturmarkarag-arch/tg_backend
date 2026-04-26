const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');

let mongoServer;

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
  const response = await request(app).post('/api/orders').send({
    buyerTelegramId,
    items: [{ productId: productDoc._id.toString(), quantity, price }],
  });
  return { response, product: productDoc };
};

beforeAll(async () => {
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

  it('returns orders with buyer details when user exists', async () => {
    await createTestUser('12345');
    const { response: createResponse } = await createOrderRequest({ buyerTelegramId: '12345', quantity: 1, price: 20 });

    expect(createResponse.status).toBe(201);

    const listResponse = await request(app).get('/api/orders');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.orders[0].buyer).toBeDefined();
    expect(listResponse.body.orders[0].buyer.shopName).toBe('Magazin');
    expect(listResponse.body.orders[0].buyer.shopCity).toBe('Kyiv');
  });

  it('returns paginated response', async () => {
    const product = await createTestProduct(10);
    for (let i = 0; i < 5; i++) {
      await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    }

    const res = await request(app).get('/api/orders?page=1&pageSize=2');

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
      await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    }

    const res = await request(app).get('/api/orders?page=2&pageSize=2');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.page).toBe(2);
  });

  it('filters orders by status', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const confirmed = await createOrderRequest({ buyerTelegramId: '222', quantity: 2, price: 20, product });
    await request(app).patch(`/api/orders/${confirmed.response.body._id}`).send({ status: 'confirmed' });

    const res = await request(app).get('/api/orders?status=confirmed');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].status).toBe('confirmed');
  });

  it('filters orders by buyerTelegramId', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: 'user111', quantity: 1, price: 10, product });
    await createOrderRequest({ buyerTelegramId: 'user222', quantity: 2, price: 20, product });

    const res = await request(app).get('/api/orders?buyerTelegramId=user111&status=all');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].buyerTelegramId).toBe('user111');
  });

  it('excludes cancelled orders by default', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const toCancel = await createOrderRequest({ buyerTelegramId: '222', quantity: 1, price: 10, product });
    await request(app).patch(`/api/orders/${toCancel.response.body._id}`).send({ status: 'cancelled' });

    const res = await request(app).get('/api/orders');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].buyerTelegramId).toBe('111');
  });

  it('returns all orders including cancelled with status=all', async () => {
    const product = await createTestProduct(10);

    await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });
    const toCancel = await createOrderRequest({ buyerTelegramId: '222', quantity: 1, price: 10, product });
    await request(app).patch(`/api/orders/${toCancel.response.body._id}`).send({ status: 'cancelled' });

    const res = await request(app).get('/api/orders?status=all');

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
  });

  it('updates order status via PATCH', async () => {
    const product = await createTestProduct(10);

    const { response: created } = await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });

    const res = await request(app)
      .patch(`/api/orders/${created.body._id}`)
      .send({ status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
  });

  it('returns 404 when updating non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .patch(`/api/orders/${fakeId}`)
      .send({ status: 'confirmed' });

    expect(res.status).toBe(404);
  });

  it('gets a single order by id', async () => {
    const product = await createTestProduct(10);

    const { response: created } = await createOrderRequest({ buyerTelegramId: '111', quantity: 1, price: 10, product });

    const res = await request(app).get(`/api/orders/${created.body._id}`);

    expect(res.status).toBe(200);
    expect(res.body.buyerTelegramId).toBe('111');
  });

  it('returns 404 for non-existent order', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/api/orders/${fakeId}`);
    expect(res.status).toBe(404);
  });
});
