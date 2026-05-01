const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');

let mongoServer;
let adminHeader;

function buildTelegramInitData(payload, botToken) {
  const rawData = {};
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    rawData[key] = stringValue;
    params.append(key, stringValue);
  }

  const checkString = Object.keys(rawData)
    .sort()
    .map((key) => `${key}=${rawData[key]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  params.append('hash', hash);
  return params.toString();
}

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
});

beforeEach(async () => {
  await User.deleteMany({});
  await DeliveryGroup.deleteMany({});
  const admin = await User.create({ telegramId: 'admin1', role: 'admin', firstName: 'Admin' });
  adminHeader = buildTelegramInitData({ user: { id: admin.telegramId, first_name: admin.firstName }, auth_date: String(Math.floor(Date.now() / 1000)) }, process.env.TELEGRAM_BOT_TOKEN);
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
      .set('x-telegram-initdata', adminHeader)
      .send({ telegramId: '888', firstName: 'Ivan', role: 'seller' });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.telegramId).toBe('888');

    const getResponse = await request(app).get('/api/users/888').set('x-telegram-initdata', adminHeader);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.firstName).toBe('Ivan');
  });

  it('lists all users', async () => {
    await User.create({ telegramId: '1', role: 'seller' });
    await User.create({ telegramId: '2', role: 'admin' });

    const res = await request(app).get('/api/users').set('x-telegram-initdata', adminHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('updates existing user on POST with same telegramId', async () => {
    await request(app)
      .post('/api/users')
      .set('x-telegram-initdata', adminHeader)
      .send({ telegramId: '999', firstName: 'Before' });

    const res = await request(app)
      .post('/api/users')
      .set('x-telegram-initdata', adminHeader)
      .send({ telegramId: '999', firstName: 'After' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('After');

    const all = await User.find();
    expect(all).toHaveLength(2);
  });

  it('deletes a user', async () => {
    await User.create({ telegramId: '777', role: 'seller' });

    const res = await request(app).delete('/api/users/777').set('x-telegram-initdata', adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('User deleted');

    const remaining = await User.find();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].telegramId).toBe('admin1');
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app).get('/api/users/nonexistent').set('x-telegram-initdata', adminHeader);
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting non-existent user', async () => {
    const res = await request(app).delete('/api/users/nonexistent').set('x-telegram-initdata', adminHeader);
    expect(res.status).toBe(404);
  });

  it('syncs delivery group when creating user with deliveryGroupId', async () => {
    const group = await DeliveryGroup.create({ name: 'TestGroup', dayOfWeek: 1 });

    await request(app)
      .post('/api/users')
      .set('x-telegram-initdata', adminHeader)
      .send({ telegramId: '500', role: 'seller', deliveryGroupId: group._id.toString() });

    const updatedGroup = await DeliveryGroup.findById(group._id);
    expect(updatedGroup.members).toContain('500');
  });

  it('removes user from delivery group on delete', async () => {
    await DeliveryGroup.create({ name: 'G', dayOfWeek: 0, members: ['600'] });
    await User.create({ telegramId: '600', role: 'seller', warehouseZone: 'G' });

    await request(app).delete('/api/users/600').set('x-telegram-initdata', adminHeader);

    const group = await DeliveryGroup.findOne({ name: 'G' });
    expect(group.members).not.toContain('600');
  });
});
