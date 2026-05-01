const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/User');
const RegistrationRequest = require('../models/RegistrationRequest');
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
  await RegistrationRequest.deleteMany({});
  const admin = await User.create({ telegramId: 'admin1', role: 'admin', firstName: 'Admin' });
  adminHeader = buildTelegramInitData({ user: { id: admin.telegramId, first_name: admin.firstName }, auth_date: String(Math.floor(Date.now() / 1000)) }, process.env.TELEGRAM_BOT_TOKEN);
});

afterEach(async () => {
  await User.deleteMany({});
  await RegistrationRequest.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Telegram registration request admin endpoints', () => {
  it('rejects a pending registration request', async () => {
    const requestDoc = await RegistrationRequest.create({
      telegramId: 'user123',
      firstName: 'Ivan',
      lastName: 'Ivanov',
      role: 'seller',
      shopName: 'Magazin',
      deliveryGroupId: 'group123',
      status: 'pending',
      meta: {},
    });

    const res = await request(app)
      .post(`/api/v1/telegram/register-requests/${requestDoc._id}/reject`)
      .set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Registration request rejected', telegramId: 'user123' });

    const updated = await RegistrationRequest.findById(requestDoc._id).lean();
    expect(updated.status).toBe('rejected');
  });

  it('blocks a pending registration request', async () => {
    const requestDoc = await RegistrationRequest.create({
      telegramId: 'user456',
      firstName: 'Petro',
      lastName: 'Petrov',
      role: 'seller',
      shopName: 'Shop',
      deliveryGroupId: 'group123',
      status: 'pending',
      meta: {},
    });

    const res = await request(app)
      .post(`/api/v1/telegram/register-requests/${requestDoc._id}/block`)
      .set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Registration request blocked', telegramId: 'user456' });

    const updated = await RegistrationRequest.findById(requestDoc._id).lean();
    expect(updated.status).toBe('blocked');
  });

  it('deletes a registration request', async () => {
    const requestDoc = await RegistrationRequest.create({
      telegramId: 'user999',
      firstName: 'Dmytro',
      lastName: 'Koval',
      role: 'warehouse',
      status: 'rejected',
      meta: {},
    });

    const res = await request(app)
      .delete(`/api/v1/telegram/register-requests/${requestDoc._id}`)
      .set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Registration request deleted', telegramId: 'user999' });

    const deleted = await RegistrationRequest.findById(requestDoc._id).lean();
    expect(deleted).toBeNull();
  });

  it('allows reapplication after a rejected request', async () => {
    await RegistrationRequest.create({
      telegramId: 'user789',
      firstName: 'Anna',
      lastName: 'Shevchenko',
      role: 'warehouse',
      status: 'rejected',
      meta: {},
    });

    const initData = buildTelegramInitData({ user: { id: 'user789' }, auth_date: String(Math.floor(Date.now() / 1000)) }, process.env.TELEGRAM_BOT_TOKEN);

    const res = await request(app)
      .post('/api/v1/telegram/register-request')
      .send({
        initData,
        firstName: 'Anna',
        lastName: 'Shevchenko',
        role: 'warehouse',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });
});
