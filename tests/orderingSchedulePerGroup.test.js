'use strict';

const {
  getOpenDateWarsaw,
  getOrderingWindowBoundsForOpenDate,
  getOrderingWindowOpenAt,
  getOrderingWindowCloseAt,
  getSessionDeliveryDate,
  getWindowDurationMinutes,
  isOrderingOpen,
  normalizeOrderingSchedule,
} = require('../utils/orderingSchedule');
const { buildLegacyCompatibleGroupSchedule } = require('../utils/legacyOrderingScheduleMigration');

const sunToMon = {
  startDay: 0,
  startHour: 16,
  startMinute: 0,
  endDay: 1,
  endHour: 7,
  endMinute: 30,
};

describe('per-group ordering calendar', () => {
  it('uses explicit start/end days with open inclusive and close exclusive', () => {
    expect(isOrderingOpen(sunToMon, new Date('2026-08-09T14:00:00Z')).isOpen).toBe(true); // Sun 16:00 Warsaw
    expect(isOrderingOpen(sunToMon, new Date('2026-08-10T05:29:00Z')).isOpen).toBe(true); // Mon 07:29
    expect(isOrderingOpen(sunToMon, new Date('2026-08-10T05:30:00Z')).isOpen).toBe(false); // Mon 07:30
  });

  it('resolves stable openDate from the explicit start boundary', () => {
    expect(getOpenDateWarsaw(sunToMon, new Date('2026-08-09T18:00:00Z'))).toBe('2026-08-09');
    expect(getOpenDateWarsaw(sunToMon, new Date('2026-08-10T12:00:00Z'))).toBe('2026-08-09');
    expect(getOrderingWindowOpenAt(sunToMon, new Date('2026-08-10T12:00:00Z')).toISOString()).toBe('2026-08-09T14:00:00.000Z');
  });

  it('handles a schedule that crosses the weekly boundary (Friday -> Monday)', () => {
    const value = {
      startDay: 5, startHour: 20, startMinute: 30,
      endDay: 1, endHour: 6, endMinute: 0,
    };
    expect(getWindowDurationMinutes(value)).toBe((2 * 24 + 9.5) * 60); // Fri 20:30 -> Mon 06:00
    expect(isOrderingOpen(value, new Date('2026-08-15T10:00:00Z')).isOpen).toBe(true); // Saturday
    expect(isOrderingOpen(value, new Date('2026-08-16T10:00:00Z')).isOpen).toBe(true); // Sunday
  });

  it('supports same-day windows with no weekday hardcode', () => {
    const value = {
      startDay: 3, startHour: 8, startMinute: 15,
      endDay: 3, endHour: 12, endMinute: 45,
    };
    expect(getWindowDurationMinutes(value)).toBe(270);
  });

  it('different groups can have different state at the same wall-clock moment', () => {
    const now = new Date('2026-08-11T08:00:00Z'); // Tue 10:00 Warsaw
    const groupA = { startDay: 2, startHour: 9, startMinute: 0, endDay: 2, endHour: 12, endMinute: 0 };
    const groupB = { startDay: 1, startHour: 8, startMinute: 0, endDay: 1, endHour: 9, endMinute: 0 };
    expect(isOrderingOpen(groupA, now).isOpen).toBe(true);
    expect(isOrderingOpen(groupB, now).isOpen).toBe(false);
    expect(getOpenDateWarsaw(groupA, now)).toBe('2026-08-11');
    expect(getOpenDateWarsaw(groupB, now)).toBe('2026-08-10');
  });

  it('builds exact historical session bounds, including Warsaw DST', () => {
    const value = { startDay: 1, startHour: 8, startMinute: 0, endDay: 2, endHour: 7, endMinute: 0 };
    const winter = getOrderingWindowBoundsForOpenDate('2026-01-12', value);
    const summer = getOrderingWindowBoundsForOpenDate('2026-08-10', value);
    expect(winter.openAt.toISOString()).toBe('2026-01-12T07:00:00.000Z');
    expect(summer.openAt.toISOString()).toBe('2026-08-10T06:00:00.000Z');
  });

  it('has deterministic Warsaw DST policy for missing/repeated 02:xx wall times', () => {
    const sunday0230 = { startDay: 0, startHour: 2, startMinute: 30, endDay: 0, endHour: 4, endMinute: 0 };
    const spring = getOrderingWindowBoundsForOpenDate('2026-03-29', sunday0230);
    const autumn = getOrderingWindowBoundsForOpenDate('2026-10-25', sunday0230);
    // Spring 02:30 does not exist: compatible policy advances by the 1h DST gap -> 03:30 CEST.
    expect(spring.openAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Autumn 02:30 exists twice: choose the earlier CEST occurrence.
    expect(autumn.openAt.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps physical delivery day independent and always resolves delivery on/after close', () => {
    const tueToThu = { startDay: 2, startHour: 10, startMinute: 15, endDay: 4, endHour: 9, endMinute: 45 };
    expect(getSessionDeliveryDate('2026-08-11', 1, tueToThu)).toBe('2026-08-17'); // Mon after Thu close

    const friToMon = { startDay: 5, startHour: 18, startMinute: 0, endDay: 1, endHour: 7, endMinute: 30 };
    expect(() => getSessionDeliveryDate('2026-08-14', 0, friToMon)).toThrow(/next session start/);
    expect(getSessionDeliveryDate('2026-08-14', 1, friToMon)).toBe('2026-08-17'); // same calendar day as close is valid
  });

  it('rejects invalid minutes and zero-length weekly windows', () => {
    expect(() => normalizeOrderingSchedule({ ...sunToMon, startMinute: 10 })).toThrow(/allowed/);
    expect(() => normalizeOrderingSchedule({
      startDay: 1, startHour: 8, startMinute: 0,
      endDay: 1, endHour: 8, endMinute: 0,
    })).toThrow(/same moment/);
  });

  it('one-time migration exactly preserves the historical Monday special case', () => {
    const legacy = { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };
    const monday = buildLegacyCompatibleGroupSchedule(1, legacy);
    expect(monday).toEqual({
      startDay: 6, startHour: 16, startMinute: 0, // old Sunday->Saturday rule preserved ONCE
      endDay: 1, endHour: 7, endMinute: 30,
    });
    const thursday = buildLegacyCompatibleGroupSchedule(4, legacy);
    expect(thursday.startDay).toBe(3);
    expect(thursday.endDay).toBe(4);
  });

  it('next close helper respects explicit end day/time', () => {
    const close = getOrderingWindowCloseAt(sunToMon, new Date('2026-08-09T18:00:00Z'));
    expect(close.toISOString()).toBe('2026-08-10T05:30:00.000Z');
  });
});
