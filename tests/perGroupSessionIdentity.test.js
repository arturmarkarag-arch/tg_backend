'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const OrderingSession = require('../models/OrderingSession');
const { getOrCreateNextSessionId, getOrCreateSessionId } = require('../utils/getOrCreateSession');

let mongod;
const open = {
  startDay: 0, startHour: 16, startMinute: 0,
  endDay: 1, endHour: 7, endMinute: 30,
};
const sameStartDifferentEnd = { ...open, endDay: 0, endHour: 18, endMinute: 0 };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  vi.useRealTimers();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await OrderingSession.deleteMany({});
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-09T18:00:00Z')); // Sun 20:00 Warsaw
});

describe('OrderingSession identity with per-group schedules', () => {
  it('same group + same start boundary remains the same session even if close time changes', async () => {
    const groupId = new mongoose.Types.ObjectId().toString();
    const first = await getOrCreateSessionId(groupId, open);
    const second = await getOrCreateSessionId(groupId, sameStartDifferentEnd);
    expect(second).toBe(first);
    expect(await OrderingSession.countDocuments({ groupId })).toBe(1);
  });

  it('different groups never share a session id', async () => {
    const a = await getOrCreateSessionId(new mongoose.Types.ObjectId().toString(), open);
    const b = await getOrCreateSessionId(new mongoose.Types.ObjectId().toString(), open);
    expect(a).not.toBe(b);
  });

  it('next session is exactly next weekly openDate and keeps a schedule snapshot', async () => {
    const groupId = new mongoose.Types.ObjectId().toString();
    const current = await getOrCreateSessionId(groupId, open);
    const next = await getOrCreateNextSessionId(groupId, open);
    expect(next).not.toBe(current);
    const docs = await OrderingSession.find({ groupId }).sort({ openDate: 1 }).lean();
    expect(docs.map((d) => d.openDate)).toEqual(['2026-08-09', '2026-08-16']);
    expect(docs[0].scheduleSnapshot.startDay).toBe(0);
    expect(docs[0].closeAt).toBeInstanceOf(Date);
  });
});
