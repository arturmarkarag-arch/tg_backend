'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'picking-server-authority-test-secret';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const app = require('../app');
const { signSession } = require('../utils/jwt');
const User = require('../models/User');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const PickingTask = require('../models/PickingTask');
const Product = require('../models/Product');
const Order = require('../models/Order');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');
const { getWarsawNow, getOpenDateWarsaw } = require('../utils/orderingSchedule');
const { runPickingMaintenanceTick } = require('../services/pickingMaintenanceScheduler');
const { materializeOpenOrderingSessions } = require('../services/orderingOpenScheduler');

let mongod;
let worker;
let auth;
let seq = 0;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongod.getUri());
  worker = await User.create({
    telegramId: '-980000000001',
    role: 'warehouse',
    firstName: 'Picking',
    lastName: 'Authority',
  });
  auth = `Bearer ${signSession(worker.telegramId)}`;
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  seq += 1;
  await Promise.all([
    DeliveryGroup.deleteMany({}),
    OrderingSession.deleteMany({}),
    PickingTask.deleteMany({}),
    Product.deleteMany({}),
    Order.deleteMany({}),
    SupplementOffer.deleteMany({}),
    SupplementRequest.deleteMany({}),
  ]);
});

async function createClosedGroup(label = 'Authority') {
  const today = getWarsawNow(new Date()).dayOfWeek;
  const day = (today + 3) % 7;
  return DeliveryGroup.create({
    name: `${label}-${seq}`,
    dayOfWeek: day,
    orderingSchedule: {
      startDay: day,
      startHour: 10,
      startMinute: 0,
      endDay: day,
      endHour: 10,
      endMinute: 15,
    },
  });
}


async function createOpenGroup(label = 'Open') {
  const current = getWarsawNow(new Date());
  const nextDay = (current.dayOfWeek + 1) % 7;
  return DeliveryGroup.create({
    name: `${label}-${seq}`,
    dayOfWeek: nextDay,
    orderingSchedule: {
      startDay: current.dayOfWeek,
      startHour: 0,
      startMinute: 0,
      endDay: nextDay,
      endHour: 0,
      endMinute: 0,
    },
  });
}

async function createCurrentSession(group, overrides = {}) {
  return OrderingSession.create({
    groupId: String(group._id),
    openDate: getOpenDateWarsaw(group.orderingSchedule),
    scheduleSnapshot: group.orderingSchedule,
    pickingStatus: 'pending',
    events: [{ at: new Date(), type: 'created' }],
    ...overrides,
  });
}

async function createProduct(orderNumber) {
  return Product.create({
    orderNumber,
    price: 1,
    quantity: 10,
    name: `Authority product ${orderNumber}`,
    brand: `Authority product ${orderNumber}`,
    status: 'active',
  });
}

function get(url) {
  return request(app).get(url).set('Authorization', auth);
}

function post(url) {
  return request(app).post(url).set('Authorization', auth);
}

describe('V48.13 server-authoritative picking lifecycle', () => {


  it('server scheduler materialises an open ordering session without any Mini App request', async () => {
    const group = await createOpenGroup('scheduler');
    expect(await OrderingSession.countDocuments({ groupId: String(group._id) })).toBe(0);

    const result = await materializeOpenOrderingSessions({ now: new Date() });
    expect(result.materializedSessions).toBeGreaterThanOrEqual(1);
    expect(await OrderingSession.countDocuments({ groupId: String(group._id) })).toBe(1);

    // Repeated scheduler ticks reuse the same {groupId, openDate} identity.
    await materializeOpenOrderingSessions({ now: new Date() });
    expect(await OrderingSession.countDocuments({ groupId: String(group._id) })).toBe(1);
  });

  it('repeated group switching/read snapshots never materialise empty OrderingSessions', async () => {
    const groups = await Promise.all([
      createClosedGroup('snapshot-a'),
      createClosedGroup('snapshot-b'),
      createClosedGroup('snapshot-c'),
    ]);

    // Model the real UI pattern: A→B→C→A repeatedly. Navigation is presentation
    // only and must remain harmless even under rapid switching.
    for (let round = 0; round < 5; round += 1) {
      for (const group of [...groups, groups[0]]) {
        const snapshot = await get(`/api/picking/session-snapshot?deliveryGroupId=${group._id}`);
        expect(snapshot.status).toBe(200);
        expect(snapshot.body.preStart).toBe(true);
      }
    }
    expect(await OrderingSession.countDocuments({})).toBe(0);

    // Rolling-deploy compatibility: even an old POST without confirm is now a
    // pure read and cannot create the session either.
    const legacyRead = await post('/api/picking/start-session').send({ deliveryGroupId: String(groups[0]._id), confirm: false });
    expect(legacyRead.status).toBe(200);
    expect(legacyRead.body.preStart).toBe(true);
    expect(await OrderingSession.countDocuments({})).toBe(0);
  });

  it('explicit confirm:true start is the picking command that may materialise the session', async () => {
    const group = await createClosedGroup('start');

    const res = await post('/api/picking/start-session').send({
      deliveryGroupId: String(group._id),
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.noOrders || res.body.started || res.body.unresolved || res.body.coverageGaps).toBeTruthy();
    expect(await OrderingSession.countDocuments({ groupId: String(group._id) })).toBe(1);
  });

  it('my-task, block-tasks, queue-stats and session-snapshot are pure reads even for an expired lock', async () => {
    const group = await createClosedGroup('reads');
    const session = await createCurrentSession(group, { pickingStatus: 'in_progress' });
    const product = await createProduct(3000 + seq);
    const oldLockedAt = new Date(Date.now() - 10 * 60 * 1000);
    const task = await PickingTask.create({
      productId: product._id,
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
      blockId: 1,
      positionIndex: 0,
      status: 'locked',
      lockedBy: String(worker.telegramId),
      lockedAt: oldLockedAt,
      items: [],
    });
    const before = await PickingTask.findById(task._id).lean();

    const responses = [
      await get(`/api/picking/session-snapshot?deliveryGroupId=${group._id}`),
      await get(`/api/picking/my-task?deliveryGroupId=${group._id}`),
      await get(`/api/picking/block-tasks?blockId=1&deliveryGroupId=${group._id}`),
      await get(`/api/picking/queue-stats?deliveryGroupId=${group._id}`),
    ];
    for (const res of responses) expect(res.status).toBe(200);

    const after = await PickingTask.findById(task._id).lean();
    expect(after.status).toBe('locked');
    expect(after.lockedBy).toBe(String(worker.telegramId));
    expect(after.lockedAt.getTime()).toBe(before.lockedAt.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('server maintenance, not a browser GET, releases expired locks', async () => {
    const group = await createClosedGroup('stale');
    const session = await createCurrentSession(group, { pickingStatus: 'in_progress' });
    const product = await createProduct(4000 + seq);
    const task = await PickingTask.create({
      productId: product._id,
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
      blockId: 1,
      positionIndex: 0,
      status: 'locked',
      lockedBy: String(worker.telegramId),
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      items: [],
    });

    await runPickingMaintenanceTick(new Date());
    const fresh = await PickingTask.findById(task._id).lean();
    expect(fresh.status).toBe('pending');
    expect(fresh.lockedBy).toBeNull();
    expect(fresh.lockedAt).toBeNull();
  });

  it('server maintenance repairs legacy duplicate fresh locks and keeps the newest lease', async () => {
    const group = await createClosedGroup('dupe');
    const session = await createCurrentSession(group, { pickingStatus: 'in_progress' });
    const [p1, p2] = await Promise.all([
      createProduct(5000 + seq * 2),
      createProduct(5001 + seq * 2),
    ]);
    const older = new Date(Date.now() - 30 * 1000);
    const newer = new Date(Date.now() - 5 * 1000);
    const [t1, t2] = await PickingTask.create([
      {
        productId: p1._id,
        deliveryGroupId: String(group._id),
        orderingSessionId: String(session._id),
        blockId: 1,
        positionIndex: 0,
        status: 'locked',
        lockedBy: String(worker.telegramId),
        lockedAt: older,
        items: [],
      },
      {
        productId: p2._id,
        deliveryGroupId: String(group._id),
        orderingSessionId: String(session._id),
        blockId: 1,
        positionIndex: 1,
        status: 'locked',
        lockedBy: String(worker.telegramId),
        lockedAt: newer,
        items: [],
      },
    ]);

    await runPickingMaintenanceTick(new Date());
    const [oldTask, newTask] = await Promise.all([
      PickingTask.findById(t1._id).lean(),
      PickingTask.findById(t2._id).lean(),
    ]);
    expect(oldTask.status).toBe('pending');
    expect(oldTask.lockedBy).toBeNull();
    expect(newTask.status).toBe('locked');
    expect(newTask.lockedBy).toBe(String(worker.telegramId));
  });

  it('completed-session presentation no longer writes lazy finalSummary during GET', async () => {
    const group = await createClosedGroup('summary');
    const session = await createCurrentSession(group, {
      pickingStatus: 'completed',
      pickingCompletedAt: new Date(),
      finalSummary: {
        processedProductCount: 0,
        totalProductCount: 0,
        archivedProductCount: 0,
        archiveRequiredProductCount: 0,
        completedOrderCount: 0,
        totalOrderCount: 0,
        finalizedAt: null,
      },
    });
    const product = await createProduct(6000 + seq);
    await PickingTask.create({
      productId: product._id,
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
      blockId: 1,
      positionIndex: 0,
      status: 'completed',
      completionReason: 'packed',
      items: [],
    });

    const res = await get(`/api/picking/session-snapshot?deliveryGroupId=${group._id}`);
    expect(res.status).toBe(200);
    const after = await OrderingSession.findById(session._id).lean();
    expect(after.finalSummary?.finalizedAt).toBeNull();
  });
});
