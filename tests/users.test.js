const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

afterEach(async () => {
  await User.deleteMany({});
  await DeliveryGroup.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Users API', () => {
  it('creates and fetches a user by telegramId', async () => {
    const createResponse = await request(app)
      .post('/api/users')
      .send({ telegramId: '888', firstName: 'Ivan', role: 'seller' });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.telegramId).toBe('888');

    const getResponse = await request(app).get('/api/users/888');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.firstName).toBe('Ivan');
  });

  it('lists all users', async () => {
    await User.create({ telegramId: '1', role: 'seller' });
    await User.create({ telegramId: '2', role: 'admin' });

    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('updates existing user on POST with same telegramId', async () => {
    await request(app)
      .post('/api/users')
      .send({ telegramId: '999', firstName: 'Before' });

    const res = await request(app)
      .post('/api/users')
      .send({ telegramId: '999', firstName: 'After' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('After');

    const all = await User.find();
    expect(all).toHaveLength(1);
  });

  it('deletes a user', async () => {
    await User.create({ telegramId: '777', role: 'seller' });

    const res = await request(app).delete('/api/users/777');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('User deleted');

    const remaining = await User.find();
    expect(remaining).toHaveLength(0);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app).get('/api/users/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting non-existent user', async () => {
    const res = await request(app).delete('/api/users/nonexistent');
    expect(res.status).toBe(404);
  });

  it('syncs delivery group when creating user with warehouseZone', async () => {
    await DeliveryGroup.create({ name: 'TestGroup', dayOfWeek: 1 });

    await request(app)
      .post('/api/users')
      .send({ telegramId: '500', role: 'seller', warehouseZone: 'TestGroup' });

    const group = await DeliveryGroup.findOne({ name: 'TestGroup' });
    expect(group.members).toContain('500');
  });

  it('removes user from delivery group on delete', async () => {
    await DeliveryGroup.create({ name: 'G', dayOfWeek: 0, members: ['600'] });
    await User.create({ telegramId: '600', role: 'seller', warehouseZone: 'G' });

    await request(app).delete('/api/users/600');

    const group = await DeliveryGroup.findOne({ name: 'G' });
    expect(group.members).not.toContain('600');
  });
});
