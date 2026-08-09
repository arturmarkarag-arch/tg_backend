'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Product = require('../models/Product');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const Block = require('../models/Block');
const { auditSessionClosure } = require('../services/sessionClosure');
const { resolveCoverageGap } = require('../services/sessionCoverage');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    DeliveryGroup.deleteMany({}),
    OrderingSession.deleteMany({}),
    Product.deleteMany({}),
    Order.deleteMany({}),
    PickingTask.deleteMany({}),
    Block.deleteMany({}),
  ]);
});

describe('coverage repair for damaged terminal Orders', () => {
  it('terminalizes a dangling fulfilled line and lets closure become clean without rewinding Order.status', async () => {
    const group = await DeliveryGroup.create({
      name: 'Repair group',
      dayOfWeek: 1, // Monday delivery
      orderingSchedule: {
        startDay: 2, startHour: 10, startMinute: 15,
        endDay: 4, endHour: 9, endMinute: 45,
      },
    });
    const session = await OrderingSession.create({
      groupId: String(group._id),
      openDate: '2026-08-04',
      pickingStatus: 'in_progress',
    });
    const product = await Product.create({
      price: 10,
      quantity: 0,
      orderNumber: 9001,
      status: 'archived',
      name: 'Archived repair product',
    });
    const shopId = new mongoose.Types.ObjectId();
    const order = await Order.create({
      buyerTelegramId: 'repair-seller',
      shopId,
      orderingSessionId: String(session._id),
      orderNumber: 9001,
      status: 'fulfilled',
      totalPrice: 20,
      buyerSnapshot: {
        shopId,
        shopName: 'Repair shop',
        deliveryGroupId: String(group._id),
      },
      items: [{
        productId: product._id,
        name: product.name,
        price: 10,
        quantity: 2,
        packed: false,
        cancelled: false,
        skipped: false,
      }],
    });

    const before = await auditSessionClosure({
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
    });
    expect(before.ok).toBe(false);
    expect(before.blockers.map((b) => b.code)).toContain('coverage_gaps');
    expect(before.blockers.map((b) => b.code)).toContain('unterminated_items');

    const repaired = await resolveCoverageGap({
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
      productId: String(product._id),
    });
    expect(repaired.cancelledCount).toBe(1);
    expect(repaired.archived).toBe(true);

    const fresh = await Order.findById(order._id).lean();
    expect(fresh.status).toBe('fulfilled');
    expect(fresh.totalPrice).toBe(0);
    expect(fresh.items[0].cancelled).toBe(true);
    expect(fresh.items[0].packed).toBe(false);
    expect(fresh.history.some((h) => h.action === 'items_cancelled_coverage_repair')).toBe(true);

    const after = await auditSessionClosure({
      deliveryGroupId: String(group._id),
      orderingSessionId: String(session._id),
    });
    expect(after.ok).toBe(true);
    expect(after.blockers).toEqual([]);
  });
});
