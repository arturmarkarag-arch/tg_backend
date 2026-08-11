'use strict';

/**
 * A late SKIP can be the LAST terminal event of an order. `applyPackedItemsToOrders`
 * closes an order only from a PACK, so without a status recompute inside the
 * reconcile such an order stays `new|in_progress` forever with nothing left to do:
 * an eternal "active order" that blocks schedule edits and reads as unfinished in
 * the session summary (found on TEST as demo order #73, 2026-08-11).
 *
 * Needs a replica set: reconcileLateOrderStrict runs in a transaction.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const { reconcileLateOrderStrict } = require('../services/lateOrderReconcile');

let mongod;
let group;
let session;

const productA = new mongoose.Types.ObjectId();
const productB = new mongoose.Types.ObjectId();
const shopId = new mongoose.Types.ObjectId();
let orderNumber = 5000;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    DeliveryGroup.deleteMany({}),
    OrderingSession.deleteMany({}),
    Order.deleteMany({}),
    PickingTask.deleteMany({}),
  ]);
  group = await DeliveryGroup.create({
    name: 'Late reconcile group',
    dayOfWeek: 1,
    orderingSchedule: {
      startDay: 2, startHour: 10, startMinute: 15,
      endDay: 4, endHour: 9, endMinute: 45,
    },
  });
  session = await OrderingSession.create({
    groupId: String(group._id),
    openDate: '2026-08-04',
    pickingStatus: 'in_progress',
  });
});

function makeOrder(items) {
  return Order.create({
    buyerTelegramId: 'late-seller',
    shopId,
    orderingSessionId: String(session._id),
    orderNumber: ++orderNumber,
    status: 'in_progress',
    totalPrice: 0,
    buyerSnapshot: { shopId, shopName: 'Late shop', deliveryGroupId: String(group._id) },
    items,
  });
}

const line = (productId, extra = {}) => ({
  productId, name: `p-${String(productId).slice(-4)}`, price: 10, quantity: 1,
  packed: false, cancelled: false, skipped: false, ...extra,
});

describe('late reconcile closes an order whose last terminal event is a skip', () => {
  it('partially delivered order becomes terminal instead of staying in_progress forever', async () => {
    const order = await makeOrder([
      line(productA, { packed: true }),
      line(productB), // no task in the frozen plan → must be skipped
    ]);

    const res = await reconcileLateOrderStrict(order._id);
    expect(res.skipped).toBe(1);
    expect(res.appended).toBe(0);

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.items.every((i) => i.packed || i.skipped || i.cancelled || i.voided)).toBe(true);
    expect(['new', 'in_progress']).not.toContain(fresh.status);
    expect(fresh.status).toBe('confirmed');
    const entry = fresh.history.find((h) => h.action === 'late_items_skipped');
    expect(entry?.meta?.to).toBe('confirmed');
  });

  it('still cancels an order that missed the delivery entirely', async () => {
    const order = await makeOrder([line(productA), line(productB)]);

    const res = await reconcileLateOrderStrict(order._id);
    expect(res.skipped).toBe(2);

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('cancelled');
    expect(fresh.history.some((h) => h.action === 'late_skipped_all')).toBe(true);
  });

  it('leaves the order active while an appended item can still be picked', async () => {
    const order = await makeOrder([line(productA, { packed: true }), line(productB)]);
    await PickingTask.create({
      productId: productB,
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
      blockId: 1,
      positionIndex: 1,
      status: 'pending',
      items: [],
    });

    const res = await reconcileLateOrderStrict(order._id);
    expect(res.appended).toBe(1);
    expect(res.skipped).toBe(0);

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('in_progress');
  });
});
