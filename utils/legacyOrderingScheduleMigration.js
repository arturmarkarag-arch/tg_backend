'use strict';

const { normalizeOrderingSchedule } = require('./orderingSchedule');

/**
 * Compatibility ONLY for the one-time migration.
 * Reproduces the historical rule exactly:
 *   start = day before delivery, except Sunday -> Saturday;
 *   end   = delivery day;
 *   times = legacy global AppSetting('ordering.schedule').
 * Runtime code must never call this helper.
 */
function legacyOpenDayForDelivery(deliveryDay) {
  const day = Number(deliveryDay);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new Error(`legacy ordering schedule: invalid delivery day (${deliveryDay})`);
  }
  const dayBefore = (day - 1 + 7) % 7;
  return dayBefore === 0 ? 6 : dayBefore;
}

function buildLegacyCompatibleGroupSchedule(deliveryDay, legacySchedule) {
  if (!legacySchedule || typeof legacySchedule !== 'object') {
    throw new Error('legacy ordering schedule is required');
  }
  return normalizeOrderingSchedule({
    startDay: legacyOpenDayForDelivery(deliveryDay),
    startHour: Number(legacySchedule.openHour),
    startMinute: Number(legacySchedule.openMinute),
    endDay: Number(deliveryDay),
    endHour: Number(legacySchedule.closeHour),
    endMinute: Number(legacySchedule.closeMinute),
  });
}

module.exports = { legacyOpenDayForDelivery, buildLegacyCompatibleGroupSchedule };
