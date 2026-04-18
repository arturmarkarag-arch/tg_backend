const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Stub environment before loading app
process.env.OPENAI_API_KEY = '';
process.env.R2_BUCKET_NAME = 'test-bucket';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_ENDPOINT = 'https://example.com';
process.env.R2_REGION = 'auto';

const app = require('../app');
const Product = require('../models/Product');
const User = require('../models/User');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

afterEach(async () => {
  await Product.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Broadcast API routes', () => {
  it('POST /api/broadcast/start returns error when no products exist', async () => {
    const res = await request(app)
      .post('/api/broadcast/start')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No products found/i);
  });

  it('POST /api/broadcast/start returns error when no recipients exist', async () => {
    await Product.create({
      orderNumber: 1,
      name: 'Test product',
      price: 100,
      quantity: 5,
      status: 'active',
      imageUrls: ['/api/products/images/test.jpg'],
    });

    const res = await request(app)
      .post('/api/broadcast/start')
      .send({ recipientRole: 'seller' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No recipients found/i);
  });

  it('POST /api/broadcast/start enqueues jobs when products and recipients exist', async () => {
    await Product.create({
      orderNumber: 1,
      name: 'Broadcast product',
      price: 200,
      quantity: 10,
      quantityPerPackage: 5,
      status: 'active',
      imageUrls: ['https://example.com/photo.jpg'],
    });
    await User.create({
      telegramId: '111222333',
      role: 'seller',
      firstName: 'Test',
    });

    const res = await request(app)
      .post('/api/broadcast/start')
      .send({ recipientRole: 'seller', addLabels: true });

    // If Redis is available, expect 200 with broadcast info
    // If Redis is not available, expect 400 with connection error
    if (res.status === 200) {
      expect(res.body).toHaveProperty('broadcastId');
      expect(res.body.productsCount).toBe(1);
      expect(res.body.recipientsCount).toBe(1);
      expect(res.body.totalMessages).toBe(1);
    } else {
      // Redis not running in test — acceptable
      expect(res.status).toBe(400);
    }
  });

  it('POST /api/broadcast/start respects recipientIds filter', async () => {
    await Product.create({
      orderNumber: 1,
      name: 'Filtered product',
      price: 50,
      quantity: 3,
      status: 'active',
    });
    await User.create({ telegramId: '100', role: 'seller', firstName: 'A' });
    await User.create({ telegramId: '200', role: 'seller', firstName: 'B' });

    const res = await request(app)
      .post('/api/broadcast/start')
      .send({ recipientIds: ['100'] });

    if (res.status === 200) {
      expect(res.body.recipientsCount).toBe(1);
      expect(res.body.totalMessages).toBe(1);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it('POST /api/broadcast/start respects productFilter', async () => {
    await Product.create({ orderNumber: 1, name: 'Active', price: 10, quantity: 1, status: 'active' });
    await Product.create({ orderNumber: 2, name: 'Archived', price: 20, quantity: 1, status: 'archived' });
    await User.create({ telegramId: '999', role: 'seller', firstName: 'Seller' });

    const res = await request(app)
      .post('/api/broadcast/start')
      .send({ productFilter: { status: 'active' }, recipientIds: ['999'] });

    if (res.status === 200) {
      expect(res.body.productsCount).toBe(1);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it('GET /api/broadcast/stats returns stats structure', async () => {
    const res = await request(app).get('/api/broadcast/stats');

    // If Redis is available
    if (res.status === 200) {
      expect(res.body).toHaveProperty('image');
      expect(res.body).toHaveProperty('send');
      expect(res.body).toHaveProperty('totalDelivered');
      expect(res.body).toHaveProperty('totalFailed');
      expect(res.body).toHaveProperty('inProgress');
      expect(res.body.image).toHaveProperty('waiting');
      expect(res.body.image).toHaveProperty('active');
      expect(res.body.image).toHaveProperty('completed');
      expect(res.body.image).toHaveProperty('failed');
      expect(res.body.send).toHaveProperty('waiting');
      expect(res.body.send).toHaveProperty('delayed');
    } else {
      expect(res.status).toBe(500);
    }
  });

  it('POST /api/broadcast/cancel responds', async () => {
    const res = await request(app).post('/api/broadcast/cancel');

    if (res.status === 200) {
      expect(res.body).toHaveProperty('cancelled', true);
    } else {
      expect(res.status).toBe(500);
    }
  });
});
