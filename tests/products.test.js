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

describe('Products API', () => {
  it('creates a product via JSON and retrieves it', async () => {
    const createResponse = await request(app)
      .post('/api/products')
      .send({ orderNumber: 1, brand: 'Test product', price: 100, quantity: 5 });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.brand).toBe('Test product');
    expect(createResponse.body.price).toBe(100);
    expect(createResponse.body.orderNumber).toBe(1);
    expect(createResponse.body.imageUrls).toEqual([]);
    expect(createResponse.body.imageNames).toEqual([]);

    const listResponse = await request(app).get('/api/products');
    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body)).toBe(true);
    expect(listResponse.body.length).toBe(1);
  });

  it('rejects product without required fields', async () => {
    const res = await request(app)
      .post('/api/products')
      .send({ name: '', price: 0, quantity: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('creates a product via multipart form-data', async () => {
    const res = await request(app)
      .post('/api/products')
      .field('orderNumber', '1')
      .field('brand', 'Multipart product')
      .field('price', '50')
      .field('quantity', '3')
      .field('status', 'active');

    expect(res.status).toBe(201);
    expect(res.body.brand).toBe('Multipart product');
    expect(res.body.price).toBe(50);
    expect(res.body.quantity).toBe(3);
    expect(res.body.status).toBe('active');
  });

  it('retrieves a single product by id', async () => {
    const created = await request(app)
      .post('/api/products')
      .send({ orderNumber: 1, brand: 'Single', price: 10, quantity: 1 });

    const res = await request(app).get(`/api/products/${created.body._id}`);
    expect(res.status).toBe(200);
    expect(res.body.brand).toBe('Single');
  });

  it('returns 404 for non-existent product', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/api/products/${fakeId}`);
    expect(res.status).toBe(404);
  });

  it('updates a product', async () => {
    const created = await request(app)
      .post('/api/products')
      .send({ orderNumber: 1, brand: 'Old name', price: 10, quantity: 1 });

    const res = await request(app)
      .patch(`/api/products/${created.body._id}`)
      .send({ brand: 'New name', price: 25 });

    expect(res.status).toBe(200);
    expect(res.body.brand).toBe('New name');
    expect(res.body.price).toBe(25);
  });

  it('soft-deletes a product (archives it)', async () => {
    const created = await request(app)
      .post('/api/products')
      .send({ orderNumber: 1, brand: 'To delete', price: 10, quantity: 1 });

    const res = await request(app).delete(`/api/products/${created.body._id}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Product archived');

    // Product still exists in DB but is archived
    const archived = await Product.findById(created.body._id);
    expect(archived).not.toBeNull();
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBeDefined();
    expect(archived.originalOrderNumber).toBe(1);
    expect(archived.orderNumber).toBe(0);

    // GET /api/products should not return archived products
    const listRes = await request(app).get('/api/products');
    expect(listRes.body).toHaveLength(0);
  });

  it('shifts later products after soft-deletion', async () => {
    await request(app).post('/api/products').send({ orderNumber: 1, brand: 'First', price: 10, quantity: 1 });
    const second = await request(app).post('/api/products').send({ orderNumber: 2, brand: 'Second', price: 12, quantity: 1 });
    await request(app).post('/api/products').send({ orderNumber: 3, brand: 'Third', price: 14, quantity: 1 });

    await request(app).delete(`/api/products/${second.body._id}`);

    const remaining = await Product.find({ status: { $ne: 'archived' } }).sort({ orderNumber: 1 });
    expect(remaining.map((p) => p.brand)).toEqual(['First', 'Third']);
    expect(remaining.map((p) => p.orderNumber)).toEqual([1, 2]);
  });

  it('shifts occupied order numbers when inserting a product', async () => {
    await request(app).post('/api/products').send({ orderNumber: 1, brand: 'First', price: 10, quantity: 1 });
    await request(app).post('/api/products').send({ orderNumber: 2, brand: 'Second', price: 12, quantity: 1 });

    const result = await request(app)
      .post('/api/products')
      .send({ orderNumber: 1, brand: 'Inserted', price: 15, quantity: 1 });

    expect(result.status).toBe(201);
    const all = await Product.find().sort({ orderNumber: 1 });
    expect(all.map((p) => p.brand)).toEqual(['Inserted', 'First', 'Second']);
    expect(all.map((p) => p.orderNumber)).toEqual([1, 2, 3]);
  });

  it('reorders products', async () => {
    const p1 = await request(app).post('/api/products').send({ orderNumber: 1, brand: 'A', price: 1, quantity: 1 });
    const p2 = await request(app).post('/api/products').send({ orderNumber: 2, brand: 'B', price: 1, quantity: 1 });

    const res = await request(app)
      .patch('/api/products/reorder')
      .send({ order: [p2.body._id, p1.body._id] });

    expect(res.status).toBe(200);

    const updated1 = await Product.findById(p1.body._id);
    const updated2 = await Product.findById(p2.body._id);
    expect(updated2.orderNumber).toBe(1);
    expect(updated1.orderNumber).toBe(2);
  });

  it('returns pending products sorted by orderNumber', async () => {
    await request(app).post('/api/products').send({ orderNumber: 2, brand: 'Pending1', price: 5, quantity: 1, status: 'pending' });
    await request(app).post('/api/products').send({ orderNumber: 1, brand: 'Pending2', price: 5, quantity: 1, status: 'pending' });
    await request(app).post('/api/products').send({ orderNumber: 3, brand: 'Active1', price: 5, quantity: 1, status: 'active' });

    const res = await request(app).get('/api/products/pending');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body.map((item) => item.brand)).toEqual(['Pending2', 'Pending1']);
  });

  it('returns 404 for non-existent image', async () => {
    const res = await request(app).get('/api/products/images/nonexistent.jpg');
    expect(res.status).toBe(404);
  });
});
