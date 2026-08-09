'use strict';

const { buildOpenClosedTestSchedules } = require('../scripts/helpers/perGroupTestSchedule');
const {
  isOrderingOpen,
  getOpenDateWarsaw,
  validateOrderingScheduleDeliveryDay,
} = require('../utils/orderingSchedule');

function expectValidPair(now) {
  const { deliveryDay, openSchedule, closedSchedule } = buildOpenClosedTestSchedules(now);
  expect(() => validateOrderingScheduleDeliveryDay(openSchedule, deliveryDay)).not.toThrow();
  expect(() => validateOrderingScheduleDeliveryDay(closedSchedule, deliveryDay)).not.toThrow();
  expect(isOrderingOpen(openSchedule, now).isOpen).toBe(true);
  expect(isOrderingOpen(closedSchedule, now).isOpen).toBe(false);
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

  it('stays valid across Warsaw midnight', () => {
    expectValidPair(new Date('2026-08-09T21:59:00Z')); // 23:59 Warsaw
    expectValidPair(new Date('2026-08-09T22:01:00Z')); // 00:01 Warsaw next day
  });

  it('stays valid across the Sunday -> Monday week boundary', () => {
    expectValidPair(new Date('2026-08-09T21:59:00Z'));
  });
});
