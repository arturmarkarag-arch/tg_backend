const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../app');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { useNewUrlParser: true, useUnifiedTopology: true });
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
      .send({ name: 'Група 1', dayOfWeek: 1 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Група 1');
    expect(res.body.dayOfWeek).toBe(1);
    expect(res.body.members).toEqual([]);
  });

  it('rejects group without required fields', async () => {
    const res = await request(app)
      .post('/api/delivery-groups')
      .send({ name: 'No day' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('lists all delivery groups', async () => {
    await DeliveryGroup.create({ name: 'G1', dayOfWeek: 0 });
    await DeliveryGroup.create({ name: 'G2', dayOfWeek: 3 });

    const res = await request(app).get('/api/delivery-groups');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('updates a delivery group', async () => {
    const group = await DeliveryGroup.create({ name: 'Old', dayOfWeek: 1 });

    const res = await request(app)
      .patch(`/api/delivery-groups/${group._id}`)
      .send({ name: 'New', dayOfWeek: 5 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.dayOfWeek).toBe(5);
  });

  it('deletes a delivery group', async () => {
    const group = await DeliveryGroup.create({ name: 'ToDelete', dayOfWeek: 2 });

    const res = await request(app).delete(`/api/delivery-groups/${group._id}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Group deleted');

    const remaining = await DeliveryGroup.find();
    expect(remaining).toHaveLength(0);
  });

  it('returns 404 when updating non-existent group', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .patch(`/api/delivery-groups/${fakeId}`)
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting non-existent group', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app).delete(`/api/delivery-groups/${fakeId}`);

    expect(res.status).toBe(404);
  });

  it('stores telegramChatId', async () => {
    const res = await request(app)
      .post('/api/delivery-groups')
      .send({ name: 'Chat group', dayOfWeek: 4, telegramChatId: '-1001234567890' });

    expect(res.status).toBe(201);
    expect(res.body.telegramChatId).toBe('-1001234567890');
  });

  describe('User <-> Group sync', () => {
    it('syncs user warehouseZone when adding members to group', async () => {
      const user = await User.create({ telegramId: '111', role: 'seller' });
      const group = await DeliveryGroup.create({ name: 'Sync Group', dayOfWeek: 1 });

      await request(app)
        .patch(`/api/delivery-groups/${group._id}`)
        .send({ members: ['111'] });

      const updated = await User.findOne({ telegramId: '111' });
      expect(updated.warehouseZone).toBe('Sync Group');
    });

    it('clears user warehouseZone when removed from group', async () => {
      const user = await User.create({ telegramId: '222', role: 'seller', warehouseZone: 'G1' });
      const group = await DeliveryGroup.create({ name: 'G1', dayOfWeek: 1, members: ['222'] });

      await request(app)
        .patch(`/api/delivery-groups/${group._id}`)
        .send({ members: [] });

      const updated = await User.findOne({ telegramId: '222' });
      expect(updated.warehouseZone).toBe('');
    });

    it('clears user warehouseZone when group is deleted', async () => {
      await User.create({ telegramId: '333', role: 'seller', warehouseZone: 'DelGroup' });
      const group = await DeliveryGroup.create({ name: 'DelGroup', dayOfWeek: 2, members: ['333'] });

      await request(app).delete(`/api/delivery-groups/${group._id}`);

      const updated = await User.findOne({ telegramId: '333' });
      expect(updated.warehouseZone).toBe('');
    });

    it('syncs group members when user is created with warehouseZone', async () => {
      await DeliveryGroup.create({ name: 'UserSync', dayOfWeek: 3 });

      await request(app)
        .post('/api/users')
        .send({ telegramId: '444', role: 'seller', warehouseZone: 'UserSync' });

      const group = await DeliveryGroup.findOne({ name: 'UserSync' });
      expect(group.members).toContain('444');
    });

    it('removes user from group members when user is deleted', async () => {
      const group = await DeliveryGroup.create({ name: 'CleanUp', dayOfWeek: 0, members: ['555'] });
      await User.create({ telegramId: '555', role: 'seller', warehouseZone: 'CleanUp' });

      await request(app).delete('/api/users/555');

      const updated = await DeliveryGroup.findById(group._id);
      expect(updated.members).not.toContain('555');
    });

    it('moves user between groups when warehouseZone changes', async () => {
      const g1 = await DeliveryGroup.create({ name: 'From', dayOfWeek: 1, members: ['666'] });
      const g2 = await DeliveryGroup.create({ name: 'To', dayOfWeek: 2 });
      await User.create({ telegramId: '666', role: 'seller', warehouseZone: 'From' });

      await request(app)
        .post('/api/users')
        .send({ telegramId: '666', warehouseZone: 'To' });

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
        .post(`/api/delivery-groups/${fakeId}/broadcast`);
      expect(res.status).toBe(404);
    });

    it('returns 400 for group with no members', async () => {
      const group = await DeliveryGroup.create({ name: 'Empty', dayOfWeek: 1, members: [] });
      const res = await request(app)
        .post(`/api/delivery-groups/${group._id}/broadcast`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/учасників/i);
    });
  });
});
