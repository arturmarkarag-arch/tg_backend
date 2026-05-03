const request = require('supertest');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');

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
  await DeliveryGroup.deleteMany({});
  await User.deleteMany({});
  const admin = await User.create({ telegramId: 'admin1', role: 'admin', firstName: 'Admin' });
  adminHeader = buildTelegramInitData({ user: { id: admin.telegramId, first_name: admin.firstName }, auth_date: String(Math.floor(Date.now() / 1000)) }, process.env.TELEGRAM_BOT_TOKEN);
});

afterEach(async () => {
  await DeliveryGroup.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Delivery Groups API', () => {
  it('creates a delivery group', async () => {
    const res = await request(app)
      .post('/api/delivery-groups')
      .set('x-telegram-initdata', adminHeader)
      .send({ name: 'Група 1', dayOfWeek: 1 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Група 1');
    expect(res.body.dayOfWeek).toBe(1);
    expect(res.body.members).toEqual([]);
  });

  it('rejects group without required fields', async () => {
    const res = await request(app)
      .post('/api/delivery-groups')
      .set('x-telegram-initdata', adminHeader)
      .send({ name: 'No day' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('lists all delivery groups', async () => {
    await DeliveryGroup.create({ name: 'G1', dayOfWeek: 0 });
    await DeliveryGroup.create({ name: 'G2', dayOfWeek: 3 });

    const res = await request(app).get('/api/delivery-groups').set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('returns public delivery group summaries without members', async () => {
    await DeliveryGroup.create({ name: 'G1', dayOfWeek: 1, members: ['user1'] });

    const res = await request(app).get('/api/delivery-groups/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: 'G1', dayOfWeek: 1 });
    expect(res.body[0].members).toBeUndefined();
  });

  it('updates a delivery group', async () => {
    const group = await DeliveryGroup.create({ name: 'Old', dayOfWeek: 1 });

    const res = await request(app)
      .patch(`/api/delivery-groups/${group._id}`)
      .set('x-telegram-initdata', adminHeader)
      .send({ name: 'New', dayOfWeek: 5 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.dayOfWeek).toBe(5);
  });

  it('deletes a delivery group', async () => {
    const group = await DeliveryGroup.create({ name: 'ToDelete', dayOfWeek: 2 });

    const res = await request(app).delete(`/api/delivery-groups/${group._id}`).set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Group deleted');

    const remaining = await DeliveryGroup.find();
    expect(remaining).toHaveLength(0);
  });

  it('returns 404 when updating non-existent group', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .patch(`/api/delivery-groups/${fakeId}`)
      .set('x-telegram-initdata', adminHeader)
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting non-existent group', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).delete(`/api/delivery-groups/${fakeId}`).set('x-telegram-initdata', adminHeader);

    expect(res.status).toBe(404);
  });

  describe('User <-> Group sync', () => {
    it('syncs user deliveryGroupId when adding members to group', async () => {
      const user = await User.create({ telegramId: '111', role: 'seller' });
      const group = await DeliveryGroup.create({ name: 'Sync Group', dayOfWeek: 1 });

      await request(app)
        .patch(`/api/delivery-groups/${group._id}`)
        .set('x-telegram-initdata', adminHeader)
        .send({ members: ['111'] });

      const updated = await User.findOne({ telegramId: '111' });
      expect(updated.deliveryGroupId).toBe(group._id.toString());
    });

    it('clears user deliveryGroupId when removed from group', async () => {
      const group = await DeliveryGroup.create({ name: 'G1', dayOfWeek: 1, members: ['222'] });
      const user = await User.create({ telegramId: '222', role: 'seller', deliveryGroupId: group._id.toString() });

      await request(app)
        .patch(`/api/delivery-groups/${group._id}`)
        .set('x-telegram-initdata', adminHeader)
        .send({ members: [] });

      const updated = await User.findOne({ telegramId: '222' });
      expect(updated.deliveryGroupId).toBe('');
    });

    it('rejects deletion when group has members', async () => {
      const group = await DeliveryGroup.create({ name: 'DelGroup', dayOfWeek: 2, members: ['333'] });
      await User.create({ telegramId: '333', role: 'seller', deliveryGroupId: group._id.toString() });

      const res = await request(app).delete(`/api/delivery-groups/${group._id}`).set('x-telegram-initdata', adminHeader);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot delete|не можна/i);

      const stillExists = await DeliveryGroup.findById(group._id);
      expect(stillExists).not.toBeNull();

      const updated = await User.findOne({ telegramId: '333' });
      expect(updated.deliveryGroupId).toBe(group._id.toString());
    });

    it('syncs group members when user is created with deliveryGroupId', async () => {
      const group = await DeliveryGroup.create({ name: 'UserSync', dayOfWeek: 3 });

      await request(app)
        .post('/api/users')
        .set('x-telegram-initdata', adminHeader)
        .send({ telegramId: '444', role: 'seller', deliveryGroupId: group._id.toString() });

      const updatedGroup = await DeliveryGroup.findById(group._id);
      expect(updatedGroup.members).toContain('444');
    });

    it('removes user from group members when user is deleted', async () => {
      const group = await DeliveryGroup.create({ name: 'CleanUp', dayOfWeek: 0, members: ['555'] });
      await User.create({ telegramId: '555', role: 'seller', warehouseZone: 'CleanUp' });

      await request(app).delete('/api/users/555').set('x-telegram-initdata', adminHeader);

      const updated = await DeliveryGroup.findById(group._id);
      expect(updated.members).not.toContain('555');
    });

    it('moves user between groups when deliveryGroupId changes', async () => {
      const g1 = await DeliveryGroup.create({ name: 'From', dayOfWeek: 1, members: ['666'] });
      const g2 = await DeliveryGroup.create({ name: 'To', dayOfWeek: 2 });
      await User.create({ telegramId: '666', role: 'seller', deliveryGroupId: g1._id.toString() });

      await request(app)
        .post('/api/users')
        .set('x-telegram-initdata', adminHeader)
        .send({ telegramId: '666', deliveryGroupId: g2._id.toString() });

      const updatedG1 = await DeliveryGroup.findById(g1._id);
      const updatedG2 = await DeliveryGroup.findById(g2._id);
      expect(updatedG1.members).not.toContain('666');
      expect(updatedG2.members).toContain('666');
    });
  });

  describe('Broadcast', () => {
    it('returns 404 for non-existent group broadcast', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/delivery-groups/${fakeId}/broadcast`)
        .set('x-telegram-initdata', adminHeader);
      expect(res.status).toBe(404);
    });

    it('returns 400 for group with no members', async () => {
      const group = await DeliveryGroup.create({ name: 'Empty', dayOfWeek: 1, members: [] });
      const res = await request(app)
        .post(`/api/delivery-groups/${group._id}/broadcast`)
        .set('x-telegram-initdata', adminHeader);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/учасників/i);
    });
  });
});
