'use strict';

/**
 * Dependency-light smoke for the v28 per-group calendar engine.
 * Uses only Node's assert + project source, so it can run before npm install.
 * It does NOT replace Vitest/E2E/MASS.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  getOpenDateWarsaw,
  getOrderingWindowBoundsForOpenDate,
  getWindowDurationMinutes,
  isOrderingOpen,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
} = require('../utils/orderingSchedule');
const { buildLegacyCompatibleGroupSchedule } = require('../utils/legacyOrderingScheduleMigration');
const { buildOpenClosedTestSchedules } = require('./helpers/perGroupTestSchedule');

const mon = {
  startDay: 6, startHour: 16, startMinute: 0,
  endDay: 1, endHour: 7, endMinute: 30,
};

assert.equal(isOrderingOpen(mon, new Date('2026-08-08T14:00:00Z')).isOpen, true, 'Sat 16:00 Warsaw opens');
assert.equal(isOrderingOpen(mon, new Date('2026-08-10T05:29:00Z')).isOpen, true, 'Mon 07:29 still open');
assert.equal(isOrderingOpen(mon, new Date('2026-08-10T05:30:00Z')).isOpen, false, 'Mon 07:30 close is exclusive');
assert.equal(getOpenDateWarsaw(mon, new Date('2026-08-09T10:00:00Z')), '2026-08-08');

const fridayToMonday = {
  startDay: 5, startHour: 20, startMinute: 30,
  endDay: 1, endHour: 6, endMinute: 0,
};
assert.equal(getWindowDurationMinutes(fridayToMonday), 3450, 'weekly boundary duration');

const groupA = { startDay: 2, startHour: 9, startMinute: 0, endDay: 2, endHour: 12, endMinute: 0 };
const groupB = { startDay: 1, startHour: 8, startMinute: 0, endDay: 1, endHour: 9, endMinute: 0 };
const sameNow = new Date('2026-08-11T08:00:00Z'); // Tue 10:00 Warsaw
assert.equal(isOrderingOpen(groupA, sameNow).isOpen, true, 'Group A independent OPEN');
assert.equal(isOrderingOpen(groupB, sameNow).isOpen, false, 'Group B independent CLOSED');

assert.throws(() => normalizeOrderingSchedule({ ...mon, startMinute: 10 }), /allowed/);
assert.throws(() => normalizeOrderingSchedule({ ...mon, endDay: 6, endHour: 16, endMinute: 0 }), /same moment/);


const independentClose = normalizeOrderingSchedule({ ...mon, endDay: 4 });
assert.equal(independentClose.endDay, 4, 'delivery day must not overwrite close weekday');
assert.doesNotThrow(() => validateOrderingScheduleDeliveryDay({ startDay: 2, startHour: 10, startMinute: 15, endDay: 4, endHour: 9, endMinute: 45 }, 1));
assert.throws(() => validateOrderingScheduleDeliveryDay({ startDay: 5, startHour: 18, startMinute: 0, endDay: 1, endHour: 7, endMinute: 30 }, 0), /next session start/);

for (const iso of ['2026-08-09T10:00:00Z', '2026-08-09T21:58:00Z', '2026-08-09T22:05:00Z']) {
  const at = new Date(iso);
  const synthetic = buildOpenClosedTestSchedules(at);
  normalizeOrderingSchedule(synthetic.openSchedule);
  normalizeOrderingSchedule(synthetic.closedSchedule);
  validateOrderingScheduleDeliveryDay(synthetic.openSchedule, synthetic.deliveryDay);
  validateOrderingScheduleDeliveryDay(synthetic.closedSchedule, synthetic.deliveryDay);
  assert.equal(isOrderingOpen(synthetic.openSchedule, at).isOpen, true, `synthetic open schedule is open @ ${iso}`);
  assert.equal(isOrderingOpen(synthetic.closedSchedule, at).isOpen, false, `synthetic closed schedule is closed @ ${iso}`);
}

const legacy = { openHour: 16, openMinute: 0, closeHour: 7, closeMinute: 30 };
assert.deepStrictEqual(buildLegacyCompatibleGroupSchedule(1, legacy), mon, 'legacy Monday must remain Saturday -> Monday at cutover');

const dst = { startDay: 0, startHour: 2, startMinute: 30, endDay: 0, endHour: 4, endMinute: 0 };
assert.equal(
  getOrderingWindowBoundsForOpenDate('2026-03-29', dst).openAt.toISOString(),
  '2026-03-29T01:30:00.000Z',
  'spring DST gap policy',
);
assert.equal(
  getOrderingWindowBoundsForOpenDate('2026-10-25', dst).openAt.toISOString(),
  '2026-10-25T00:30:00.000Z',
  'autumn DST overlap policy',
);

const root = path.resolve(__dirname, '..');
assert.equal(fs.existsSync(path.join(root, 'utils/getOrderingSchedule.js')), false, 'legacy runtime utility must not exist');
for (const dir of ['routes', 'services']) {
  const walk = (current) => {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        assert(!/getOrderingSchedule|utils\/getOrderingSchedule/.test(src), `legacy global schedule dependency: ${full}`);
      }
    }
  };
  walk(path.join(root, dir));
}

console.log('✅ v28 per-group schedule + harness smoke: PASS');
