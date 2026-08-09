'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const DeliveryGroup = require('../models/DeliveryGroup');
const {
  auditDeliveryGroupSchedules,
  assertDeliveryGroupSchedulesReady,
} = require('../utils/deliveryGroupSchedulePreflight');

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
  await mongoose.connection.db.collection('deliverygroups').deleteMany({});
});

describe('DeliveryGroup orderingSchedule startup preflight', () => {
  it('rejects an old raw DeliveryGroup without an individual schedule', async () => {
    await mongoose.connection.db.collection('deliverygroups').insertOne({
      name: 'Legacy Monday',
      dayOfWeek: 1,
      members: [],
    });

    const report = await auditDeliveryGroupSchedules();
    expect(report.total).toBe(1);
    expect(report.invalid).toHaveLength(1);
    await expect(assertDeliveryGroupSchedulesReady()).rejects.toThrow(/migrateDeliveryGroupSchedules/);
  });

  it('accepts a close weekday that differs from the physical delivery weekday', async () => {
    await mongoose.connection.db.collection('deliverygroups').insertOne({
      name: 'Monday delivery, Thursday close',
      dayOfWeek: 1,
      members: [],
      orderingSchedule: {
        startDay: 2, startHour: 16, startMinute: 0,
        endDay: 4, endHour: 7, endMinute: 30,
      },
    });

    const report = await auditDeliveryGroupSchedules();
    expect(report.invalid).toEqual([]);
  });

  it('model preserves orderingSchedule.endDay independently from dayOfWeek', async () => {
    const group = await DeliveryGroup.create({
      name: 'Monday delivery, Thursday close',
      dayOfWeek: 1,
      members: [],
      orderingSchedule: {
        startDay: 2, startHour: 16, startMinute: 0,
        endDay: 4, endHour: 7, endMinute: 30,
      },
    });
    expect(group.dayOfWeek).toBe(1);
    expect(group.orderingSchedule.endDay).toBe(4);
  });

  it('persists edited hours/minutes instead of returning the old nested schedule', async () => {
    const group = await DeliveryGroup.create({
      name: 'Editable Monday',
      dayOfWeek: 1,
      members: [],
      orderingSchedule: {
        startDay: 6, startHour: 16, startMinute: 0,
        endDay: 1, endHour: 7, endMinute: 30,
      },
    });

    group.orderingSchedule = {
      startDay: 5, startHour: 18, startMinute: 15,
      endDay: 1, endHour: 9, endMinute: 45,
    };
    await group.save();

    const fresh = await DeliveryGroup.findById(group._id).lean();
    expect(fresh.orderingSchedule).toMatchObject({
      startDay: 5, startHour: 18, startMinute: 15,
      endDay: 1, endHour: 9, endMinute: 45,
    });
  });

  it('accepts a valid quarter-hour per-group schedule', async () => {
    await DeliveryGroup.create({
      name: 'Monday',
      dayOfWeek: 1,
      members: [],
      orderingSchedule: {
        startDay: 6, startHour: 16, startMinute: 0,
        endDay: 1, endHour: 7, endMinute: 30,
      },
    });

    const report = await assertDeliveryGroupSchedulesReady();
    expect(report.invalid).toEqual([]);
    expect(report.total).toBe(1);
  });
});
