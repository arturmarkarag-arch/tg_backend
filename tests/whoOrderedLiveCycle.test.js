'use strict';

/**
 * "Хто замовив?" in the global staff catalogue must resolve to exactly ONE
 * delivery group — the live cycle.
 *
 * Delivery groups take turns across the week rather than running in parallel:
 * a group's window opens, closes, then there is dead air until the NEXT group
 * opens. So the live group is the one whose window opened last, and it stays
 * live through the dead air and through picking, handing over at the precise
 * moment the next group's window opens — not a minute earlier.
 *
 * Fanning out over every group (a section each) is what used to make the panel
 * read like "all sessions of all shops".
 */
const { pickLastOpenedGroup } = require('../routes/products');

// 2026-08-24 is a Monday. Warsaw is UTC+2 in August.
const warsaw = (iso) => new Date(iso);

const MONDAY_GROUP = {
  _id: 'mon',
  name: 'Понеділок',
  orderingSchedule: {
    startDay: 1, startHour: 15, startMinute: 0,
    endDay: 2, endHour: 7, endMinute: 30,
  },
};

const WEDNESDAY_GROUP = {
  _id: 'wed',
  name: 'Середа',
  orderingSchedule: {
    startDay: 3, startHour: 15, startMinute: 0,
    endDay: 4, endHour: 7, endMinute: 30,
  },
};

const GROUPS = [WEDNESDAY_GROUP, MONDAY_GROUP]; // deliberately unsorted

describe('who-ordered live cycle', () => {
  it('picks the group whose window opened last, not every group', () => {
    // Tue 10:00 Warsaw — Monday's window already closed (07:30), Wednesday's
    // has not opened. The Monday cycle is still the live one.
    const live = pickLastOpenedGroup(GROUPS, warsaw('2026-08-25T08:00:00Z'));
    expect(live.name).toBe('Понеділок');
  });

  it('holds the live group through dead air after its window closes', () => {
    // Wed 14:59 Warsaw — one minute before the handover.
    const live = pickLastOpenedGroup(GROUPS, warsaw('2026-08-26T12:59:00Z'));
    expect(live.name).toBe('Понеділок');
  });

  it('hands over exactly when the next group window opens', () => {
    // Wed 15:01 Warsaw.
    const live = pickLastOpenedGroup(GROUPS, warsaw('2026-08-26T13:01:00Z'));
    expect(live.name).toBe('Середа');
  });

  it('keeps the new group through ITS dead air and picking', () => {
    // Thu 09:00 Warsaw — Wednesday's window closed at 07:30, picking is on.
    const live = pickLastOpenedGroup(GROUPS, warsaw('2026-08-27T07:00:00Z'));
    expect(live.name).toBe('Середа');
  });

  it('resolves a live group at every moment of the week', () => {
    const start = Date.parse('2026-08-24T00:00:00Z');
    const STEP = 15 * 60 * 1000;
    for (let i = 0; i < (7 * 24 * 60) / 15; i += 1) {
      const at = new Date(start + i * STEP);
      expect(pickLastOpenedGroup(GROUPS, at)).toBeTruthy();
    }
  });

  it('returns null only when there are no groups at all', () => {
    expect(pickLastOpenedGroup([], new Date('2026-08-25T08:00:00Z'))).toBeNull();
  });
});
