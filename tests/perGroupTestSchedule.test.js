'use strict';

const { buildOpenClosedTestSchedules } = require('../scripts/helpers/perGroupTestSchedule');
const {
  isOrderingOpen,
  getOpenDateWarsaw,
  validateOrderingScheduleDeliveryDay,
  getPickingReadiness,
} = require('../utils/orderingSchedule');

function expectValidPair(now) {
  const { deliveryDay, openSchedule, closedSchedule } = buildOpenClosedTestSchedules(now);
  expect(() => validateOrderingScheduleDeliveryDay(openSchedule, deliveryDay)).not.toThrow();
  expect(() => validateOrderingScheduleDeliveryDay(closedSchedule, deliveryDay)).not.toThrow();
  expect(isOrderingOpen(openSchedule, now).isOpen).toBe(true);
  expect(isOrderingOpen(closedSchedule, now).isOpen).toBe(false);
  expect(getPickingReadiness(closedSchedule, now).pickingReady).toBe(true);
  expect(getOpenDateWarsaw(openSchedule, now)).toBe(getOpenDateWarsaw(closedSchedule, now));
  expect([
    openSchedule.startDay, openSchedule.startHour, openSchedule.startMinute,
  ]).toEqual([
    closedSchedule.startDay, closedSchedule.startHour, closedSchedule.startMinute,
  ]);
}

describe('live E2E per-group schedule fixture', () => {
  it('stays valid during an ordinary daytime minute', () => {
    expectValidPair(new Date('2026-08-10T10:07:00Z'));
  });


  it('never lands inside the +60s picking readiness gap on a quarter boundary', () => {
    expectValidPair(new Date('2026-08-10T08:15:01Z')); // 10:15:01 Warsaw
    expectValidPair(new Date('2026-08-10T08:15:59Z')); // 10:15:59 Warsaw
    expectValidPair(new Date('2026-08-10T08:30:00Z')); // exact next quarter
  });

  it('stays valid across Warsaw midnight', () => {
    expectValidPair(new Date('2026-08-09T21:59:00Z')); // 23:59 Warsaw
    expectValidPair(new Date('2026-08-09T22:01:00Z')); // 00:01 Warsaw next day
  });

  it('stays valid across the Sunday -> Monday week boundary', () => {
    expectValidPair(new Date('2026-08-09T21:59:00Z'));
  });

  it('stays valid across the Warsaw spring DST jump', () => {
    expectValidPair(new Date('2026-03-29T00:59:00Z'));
    expectValidPair(new Date('2026-03-29T01:01:00Z'));
  });

  it('stays valid across the Warsaw autumn DST fallback', () => {
    expectValidPair(new Date('2026-10-25T00:59:00Z'));
    expectValidPair(new Date('2026-10-25T01:01:00Z'));
  });
});
