'use strict';

const { getWarsawNow, normalizeOrderingSchedule, validateOrderingScheduleDeliveryDay, isOrderingOpen } = require('../../utils/orderingSchedule');

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

function splitWeekMinute(total) {
  const normalized = ((total % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES;
  const day = Math.floor(normalized / DAY_MINUTES);
  const dayMinute = normalized % DAY_MINUTES;
  return { day, hour: Math.floor(dayMinute / 60), minute: dayMinute % 60 };
}

/**
 * Build two short synthetic schedules with the SAME weekly start boundary:
 * - `openSchedule` contains `now`;
 * - `closedSchedule` has already closed at `now`;
 * - one `deliveryDay` is valid for BOTH schedules under the production
 *   delivery-before-next-session validator.
 *
 * Do not force closeDay === deliveryDay. That was the old test assumption and
 * is exactly what broke near midnight: a same-weekday end-before-start encoded
 * an almost-seven-day window and pushed delivery onto/after the next start.
 * Keeping the synthetic windows short (< 2h) mirrors real calendar semantics
 * without depending on a specific weekday.
 */
function buildOpenClosedTestSchedules(nowDate = new Date()) {
  const now = getWarsawNow(nowDate);
  const current = now.dayOfWeek * DAY_MINUTES + now.hour * 60 + now.minute;
  const currentQuarter = Math.floor(current / 15) * 15;

  // Same start boundary/session identity for both phases.
  const startPoint = splitWeekMinute(currentQuarter - 15);
  const closedEnd = splitWeekMinute(currentQuarter);
  const openEnd = splitWeekMinute(currentQuarter + 60);

  const start = {
    startDay: startPoint.day,
    startHour: startPoint.hour,
    startMinute: startPoint.minute,
  };
  const openSchedule = normalizeOrderingSchedule({
    ...start,
    endDay: openEnd.day,
    endHour: openEnd.hour,
    endMinute: openEnd.minute,
  });
  const closedSchedule = normalizeOrderingSchedule({
    ...start,
    endDay: closedEnd.day,
    endHour: closedEnd.hour,
    endMinute: closedEnd.minute,
  });

  // Delivery happens on the open schedule's close weekday. For the already-
  // closed schedule this is either the same day or the immediately following
  // day, so both remain inside the same weekly session cycle.
  const deliveryDay = openEnd.day;

  // Self-validate the fixture generator. A harness must never return a group
  // that production DeliveryGroup.create() would reject.
  validateOrderingScheduleDeliveryDay(openSchedule, deliveryDay);
  validateOrderingScheduleDeliveryDay(closedSchedule, deliveryDay);

  if (!isOrderingOpen(openSchedule, nowDate).isOpen) {
    throw new Error('perGroupTestSchedule: openSchedule is not open');
  }
  if (isOrderingOpen(closedSchedule, nowDate).isOpen) {
    throw new Error('perGroupTestSchedule: closedSchedule is not closed');
  }

  return { deliveryDay, openSchedule, closedSchedule };
}

module.exports = { buildOpenClosedTestSchedules };
