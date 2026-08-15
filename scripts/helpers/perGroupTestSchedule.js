'use strict';

const { getWarsawNow, normalizeOrderingSchedule, validateOrderingScheduleDeliveryDay, isOrderingOpen, getPickingReadiness, getOpenDateWarsaw } = require('../../utils/orderingSchedule');

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
 * - `closedSchedule` has already closed far enough in the past that the
 *   server-authoritative +60s picking readiness gate is definitely satisfied;
 * - one `deliveryDay` is valid for BOTH schedules under the production
 *   delivery-before-next-session validator.
 *
 * Do not force closeDay === deliveryDay. That was the old test assumption and
 * is exactly what broke near midnight: a same-weekday end-before-start encoded
 * an almost-seven-day window and pushed delivery onto/after the next start.
 * Keeping the synthetic windows short (< 2h) mirrors real calendar semantics
 * without depending on a specific weekday. The closed phase ends one full
 * quarter before the current quarter, so a test started at HH:15:01 cannot
 * randomly hit the production +60s readiness guard.
 */
function buildOpenClosedTestSchedules(nowDate = new Date()) {
  const now = getWarsawNow(nowDate);
  const current = now.dayOfWeek * DAY_MINUTES + now.hour * 60 + now.minute;
  const currentQuarter = Math.floor(current / 15) * 15;
  const openEnd = splitWeekMinute(currentQuarter + 60);
  const deliveryDay = openEnd.day;

  // Search quarter-aligned candidates instead of assuming local wall-clock
  // subtraction maps 1:1 to elapsed time. On the spring DST jump, e.g. 02:30
  // Warsaw does not exist; on the autumn fallback 02:xx occurs twice. The
  // production schedule utilities already define those semantics, so the
  // fixture generator asks THEM which candidate is simultaneously open/closed,
  // same-session and picking-ready instead of maintaining a second DST model.
  for (let startQuartersAgo = 2; startQuartersAgo <= 16; startQuartersAgo += 1) {
    const startPoint = splitWeekMinute(currentQuarter - startQuartersAgo * 15);
    const start = {
      startDay: startPoint.day,
      startHour: startPoint.hour,
      startMinute: startPoint.minute,
    };

    for (let closedQuartersAgo = 1; closedQuartersAgo < startQuartersAgo; closedQuartersAgo += 1) {
      const closedEnd = splitWeekMinute(currentQuarter - closedQuartersAgo * 15);
      try {
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

        validateOrderingScheduleDeliveryDay(openSchedule, deliveryDay);
        validateOrderingScheduleDeliveryDay(closedSchedule, deliveryDay);

        if (!isOrderingOpen(openSchedule, nowDate).isOpen) continue;
        if (isOrderingOpen(closedSchedule, nowDate).isOpen) continue;
        if (!getPickingReadiness(closedSchedule, nowDate).pickingReady) continue;
        if (getOpenDateWarsaw(openSchedule, nowDate) !== getOpenDateWarsaw(closedSchedule, nowDate)) continue;

        return { deliveryDay, openSchedule, closedSchedule };
      } catch (_) {
        // Candidate crosses a wall-clock/DST/delivery constraint incorrectly;
        // try another quarter pair. Failure to find any candidate below is hard.
      }
    }
  }

  throw new Error('perGroupTestSchedule: no DST-safe open/closed picking-ready fixture found');
}

/**
 * DST-safe schedule-edit guard fixture. All three schedules share one weekly
 * start boundary/session identity while representing two safely-closed states
 * and one currently-open state. This replaces the old wall-clock +/- minute
 * arithmetic in liveScheduleGuardE2E.js.
 */
function buildScheduleGuardTestSchedules(nowDate = new Date()) {
  const now = getWarsawNow(nowDate);
  const current = now.dayOfWeek * DAY_MINUTES + now.hour * 60 + now.minute;
  const currentQuarter = Math.floor(current / 15) * 15;

  for (let startQuartersAgo = 10; startQuartersAgo <= 32; startQuartersAgo += 1) {
    const startPoint = splitWeekMinute(currentQuarter - startQuartersAgo * 15);
    const start = { startDay: startPoint.day, startHour: startPoint.hour, startMinute: startPoint.minute };

    for (let closedAQuartersAgo = 6; closedAQuartersAgo < startQuartersAgo; closedAQuartersAgo += 1) {
      for (let closedBQuartersAgo = 2; closedBQuartersAgo < closedAQuartersAgo; closedBQuartersAgo += 1) {
        const aEnd = splitWeekMinute(currentQuarter - closedAQuartersAgo * 15);
        const bEnd = splitWeekMinute(currentQuarter - closedBQuartersAgo * 15);
        const openEnd = splitWeekMinute(currentQuarter + 4 * 15);
        const deliveryDay = openEnd.day;
        try {
          const closedA = normalizeOrderingSchedule({
            ...start, endDay: aEnd.day, endHour: aEnd.hour, endMinute: aEnd.minute,
          });
          const closedB = normalizeOrderingSchedule({
            ...start, endDay: bEnd.day, endHour: bEnd.hour, endMinute: bEnd.minute,
          });
          const openNow = normalizeOrderingSchedule({
            ...start, endDay: openEnd.day, endHour: openEnd.hour, endMinute: openEnd.minute,
          });
          for (const schedule of [closedA, closedB, openNow]) validateOrderingScheduleDeliveryDay(schedule, deliveryDay);
          if (isOrderingOpen(closedA, nowDate).isOpen || isOrderingOpen(closedB, nowDate).isOpen) continue;
          if (!getPickingReadiness(closedA, nowDate).pickingReady || !getPickingReadiness(closedB, nowDate).pickingReady) continue;
          if (!isOrderingOpen(openNow, nowDate).isOpen) continue;
          const key = getOpenDateWarsaw(openNow, nowDate);
          if (getOpenDateWarsaw(closedA, nowDate) !== key || getOpenDateWarsaw(closedB, nowDate) !== key) continue;
          return { closedA, closedB, openNow, deliveryDay };
        } catch (_) {
          // Try the next production-valid Warsaw/DST candidate.
        }
      }
    }
  }
  throw new Error('perGroupTestSchedule: no DST-safe schedule-guard fixture found');
}

module.exports = { buildOpenClosedTestSchedules, buildScheduleGuardTestSchedules };
