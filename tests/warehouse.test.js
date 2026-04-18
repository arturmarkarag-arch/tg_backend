const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const Product = require('../models/Product');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

afterEach(async () => {
  await Product.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Warehouse API', () => {
  it('assigns products to a warehouse task', async () => {
    const product = await Product.create({ name: 'Warehouse product', price: 10, quantity: 2 });

    const response = await request(app)
      .post('/api/warehouse/assign')
      .send({ productIds: [product._id.toString()], workerId: 'worker-1' });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(1);
    expect(response.body.workerId).toBe('worker-1');
    expect(response.body.taskId).toBeDefined();
  });
});
