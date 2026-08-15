const {
  buildWarsawDateRange,
  formatWarsawDateKey,
  formatWarsawDateTime,
  warsawDateKeyToUtcRange,
} = require('../utils/warsawDateTime');

describe('Europe/Warsaw calendar boundaries', () => {
  it('maps an instant after Warsaw midnight to the correct Warsaw day', () => {
    const instant = new Date('2026-08-14T22:30:00.000Z');
    expect(formatWarsawDateKey(instant)).toBe('2026-08-15');
    expect(formatWarsawDateTime(instant)).toContain('15.08.2026');
    expect(formatWarsawDateTime(instant)).toContain('00:30');
  });

  it('uses 23-hour Warsaw day on DST spring-forward', () => {
    const range = warsawDateKeyToUtcRange('2026-03-29');
    expect(range.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(range.endExclusive - range.start).toBe(23 * 60 * 60 * 1000);
  });

  it('uses 25-hour Warsaw day on DST autumn rollback', () => {
    const range = warsawDateKeyToUtcRange('2026-10-25');
    expect(range.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(range.endExclusive - range.start).toBe(25 * 60 * 60 * 1000);
  });

  it('builds an inclusive local-date range with exclusive next-midnight end', () => {
    const range = buildWarsawDateRange({ dateFrom: '2026-08-15', dateTo: '2026-08-15' });
    expect(range.$gte.toISOString()).toBe('2026-08-14T22:00:00.000Z');
    expect(range.$lt.toISOString()).toBe('2026-08-15T22:00:00.000Z');
  });
});
