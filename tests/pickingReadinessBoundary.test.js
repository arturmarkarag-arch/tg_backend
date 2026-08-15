'use strict';

const {
  isOrderingOpen,
  getPickingReadyAt,
  getPickingReadiness,
  PICKING_READY_DELAY_MS,
} = require('../utils/orderingSchedule');

// Sunday 16:00 -> Monday 07:30, Europe/Warsaw (CEST in August 2026).
const schedule = {
  startDay: 0,
  startHour: 16,
  startMinute: 0,
  endDay: 1,
  endHour: 7,
  endMinute: 30,
};

function d(iso) { return new Date(iso); }

describe('V48.14 server-authoritative picking readiness boundary', () => {
  it('keeps ordering open until the exact close boundary', () => {
    expect(isOrderingOpen(schedule, d('2026-08-17T05:29:59.000Z')).isOpen).toBe(true);
    expect(isOrderingOpen(schedule, d('2026-08-17T05:30:00.000Z')).isOpen).toBe(false);
  });

  it('uses one absolute close+60s picking-ready boundary', () => {
    expect(PICKING_READY_DELAY_MS).toBe(60_000);
    expect(getPickingReadyAt(schedule, d('2026-08-17T05:29:59.000Z')).toISOString())
      .toBe('2026-08-17T05:31:00.000Z');
    expect(getPickingReadyAt(schedule, d('2026-08-17T05:30:59.000Z')).toISOString())
      .toBe('2026-08-17T05:31:00.000Z');
  });

  it.each([
    ['07:29:59', '2026-08-17T05:29:59.000Z', false, 61_000],
    ['07:30:00', '2026-08-17T05:30:00.000Z', false, 60_000],
    ['07:30:59', '2026-08-17T05:30:59.000Z', false, 1_000],
    ['07:31:00', '2026-08-17T05:31:00.000Z', true, 0],
  ])('%s Warsaw -> ready=%s', (_label, iso, expectedReady, expectedMs) => {
    const result = getPickingReadiness(schedule, d(iso));
    expect(result.pickingReady).toBe(expectedReady);
    expect(result.pickingReadyInMs).toBe(expectedMs);
    expect(result.pickingReadyAt.toISOString()).toBe('2026-08-17T05:31:00.000Z');
  });
});
