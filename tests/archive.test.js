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

describe('Archive API', () => {
  it('returns empty archive when no archived products exist', async () => {
    const res = await request(app).get('/api/archive');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it('returns archived products grouped by day', async () => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await Product.create({ brand: 'Archived1', price: 10, quantity: 1, orderNumber: 0, status: 'archived', archivedAt: today });
    await Product.create({ brand: 'Archived2', price: 20, quantity: 2, orderNumber: 0, status: 'archived', archivedAt: yesterday });
    await Product.create({ brand: 'Active', price: 30, quantity: 3, orderNumber: 1, status: 'active' });

    const res = await request(app).get('/api/archive');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.groups.length).toBeGreaterThanOrEqual(1);
    // Active product should NOT appear
    const allNames = res.body.groups.flatMap((g) => g.items.map((i) => i.brand));
    expect(allNames).toContain('Archived1');
    expect(allNames).toContain('Archived2');
    expect(allNames).not.toContain('Active');
  });

  it('does not include products archived more than 30 days ago', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 31);

    await Product.create({ brand: 'Old', price: 10, quantity: 1, orderNumber: 0, status: 'archived', archivedAt: oldDate });
    await Product.create({ brand: 'Recent', price: 10, quantity: 1, orderNumber: 0, status: 'archived', archivedAt: new Date() });

    const res = await request(app).get('/api/archive');

    expect(res.body.total).toBe(1);
    const allNames = res.body.groups.flatMap((g) => g.items.map((i) => i.brand));
    expect(allNames).toContain('Recent');
    expect(allNames).not.toContain('Old');
  });

  it('paginates archived products', async () => {
    for (let i = 0; i < 5; i++) {
      await Product.create({ brand: `Prod${i}`, price: 10, quantity: 1, orderNumber: 0, status: 'archived', archivedAt: new Date() });
    }

    const res = await request(app).get('/api/archive?page=1&pageSize=2');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.pageCount).toBe(3);
    const itemCount = res.body.groups.reduce((sum, g) => sum + g.items.length, 0);
    expect(itemCount).toBe(2);
  });

  describe('Restore', () => {
    it('restores an archived product to active status', async () => {
      const product = await Product.create({
        brand: 'ToRestore', price: 10, quantity: 1,
        orderNumber: 0, status: 'archived', archivedAt: new Date(),
        originalOrderNumber: 3,
      });

      const res = await request(app).post(`/api/archive/${product._id}/restore`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.archivedAt).toBeNull();
      expect(res.body.originalOrderNumber).toBeNull();
      expect(res.body.orderNumber).toBe(3);
    });

    it('restores to end of list when no originalOrderNumber', async () => {
      await Product.create({ brand: 'Existing', price: 10, quantity: 1, orderNumber: 5, status: 'active' });
      const product = await Product.create({
        brand: 'NoOriginal', price: 10, quantity: 1,
        orderNumber: 0, status: 'archived', archivedAt: new Date(),
        originalOrderNumber: null,
      });

      const res = await request(app).post(`/api/archive/${product._id}/restore`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.orderNumber).toBe(6);
    });

    it('returns 404 for non-existent product', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).post(`/api/archive/${fakeId}/restore`);
      expect(res.status).toBe(404);
    });

    it('returns 400 when product is not archived', async () => {
      const product = await Product.create({ brand: 'Active', price: 10, quantity: 1, orderNumber: 1, status: 'active' });
      const res = await request(app).post(`/api/archive/${product._id}/restore`);
      expect(res.status).toBe(400);
    });

    it('shifts existing products when restoring to original position', async () => {
      await Product.create({ brand: 'P1', price: 10, quantity: 1, orderNumber: 1, status: 'active' });
      await Product.create({ brand: 'P2', price: 10, quantity: 1, orderNumber: 2, status: 'active' });
      await Product.create({ brand: 'P3', price: 10, quantity: 1, orderNumber: 3, status: 'active' });

      const archived = await Product.create({
        brand: 'Restored', price: 10, quantity: 1,
        orderNumber: 0, status: 'archived', archivedAt: new Date(),
        originalOrderNumber: 2,
      });

      await request(app).post(`/api/archive/${archived._id}/restore`);

      const all = await Product.find({ status: { $ne: 'archived' } }).sort({ orderNumber: 1 });
      expect(all.map((p) => p.brand)).toEqual(['P1', 'Restored', 'P2', 'P3']);
      expect(all.map((p) => p.orderNumber)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('Permanent delete', () => {
    it('permanently deletes an archived product', async () => {
      const product = await Product.create({
        brand: 'ToDelete', price: 10, quantity: 1,
        orderNumber: 0, status: 'archived', archivedAt: new Date(),
      });

      const res = await request(app).delete(`/api/archive/${product._id}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Product permanently deleted');

      const found = await Product.findById(product._id);
      expect(found).toBeNull();
    });

    it('returns 404 for non-existent product', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).delete(`/api/archive/${fakeId}`);
      expect(res.status).toBe(404);
    });

    it('returns 400 when product is not archived', async () => {
      const product = await Product.create({ brand: 'Active', price: 10, quantity: 1, orderNumber: 1, status: 'active' });
      const res = await request(app).delete(`/api/archive/${product._id}`);
      expect(res.status).toBe(400);
    });
  });
});
