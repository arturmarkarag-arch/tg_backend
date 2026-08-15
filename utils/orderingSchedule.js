'use strict';

/**
 * Per-delivery-group weekly ordering schedule.
 *
 * Every DeliveryGroup owns an explicit window:
 *   startDay/startHour/startMinute -> endDay/endHour/endMinute
 *
 * There is deliberately NO runtime fallback to the legacy global
 * AppSetting('ordering.schedule') and NO special-case Monday/Sunday logic.
 * All calendar math is done in Europe/Warsaw.
 */

const TIMEZONE = 'Europe/Warsaw';
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const ALLOWED_MINUTES = new Set([0, 15, 30, 45]);

const DAY_SHORT_UK = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAY_FULL_UK  = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п\'ятницю", 'суботу'];

function assertIntRange(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`orderingSchedule: invalid '${field}' (${value})`);
  }
}

function normalizeOrderingSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('orderingSchedule: group orderingSchedule is required');
  }

  const out = {
    startDay: Number(schedule.startDay),
    startHour: Number(schedule.startHour),
    startMinute: Number(schedule.startMinute),
    endDay: Number(schedule.endDay),
    endHour: Number(schedule.endHour),
    endMinute: Number(schedule.endMinute),
  };

  assertIntRange(out.startDay, 0, 6, 'startDay');
  assertIntRange(out.endDay, 0, 6, 'endDay');
  assertIntRange(out.startHour, 0, 23, 'startHour');
  assertIntRange(out.endHour, 0, 23, 'endHour');
  if (!ALLOWED_MINUTES.has(out.startMinute)) {
    throw new Error(`orderingSchedule: invalid 'startMinute' (${out.startMinute}); allowed: 0,15,30,45`);
  }
  if (!ALLOWED_MINUTES.has(out.endMinute)) {
    throw new Error(`orderingSchedule: invalid 'endMinute' (${out.endMinute}); allowed: 0,15,30,45`);
  }

  if (toWeekMinute(out.startDay, out.startHour, out.startMinute)
      === toWeekMinute(out.endDay, out.endHour, out.endMinute)) {
    throw new Error('orderingSchedule: start and end cannot be the same moment');
  }

  return out;
}


function toWeekMinute(day, hour, minute) {
  return day * DAY_MINUTES + hour * 60 + minute;
}

function getWindowDurationMinutes(schedule) {
  const s = normalizeOrderingSchedule(schedule);
  const start = toWeekMinute(s.startDay, s.startHour, s.startMinute);
  const end = toWeekMinute(s.endDay, s.endHour, s.endMinute);
  return (end - start + WEEK_MINUTES) % WEEK_MINUTES;
}

/**
 * Validates that the physical delivery day still belongs to the same weekly
 * session cycle: ordering closes first, then delivery happens, and only after
 * that may the next session start. This keeps the existing single-current-
 * session model unambiguous even though close weekday and delivery weekday are
 * configured independently.
 */
function validateOrderingScheduleDeliveryDay(schedule, deliveryDayOfWeek) {
  const s = normalizeOrderingSchedule(schedule);
  const deliveryDay = Number(deliveryDayOfWeek);
  assertIntRange(deliveryDay, 0, 6, 'deliveryDayOfWeek');

  const startMins = s.startHour * 60 + s.startMinute;
  const endMins = s.endHour * 60 + s.endMinute;
  let closeOffsetDays = (s.endDay - s.startDay + 7) % 7;
  if (closeOffsetDays === 0 && endMins <= startMins) closeOffsetDays = 7;

  const deliveryOffsetAfterClose = (deliveryDay - s.endDay + 7) % 7;
  const deliveryOffsetFromStart = closeOffsetDays + deliveryOffsetAfterClose;

  if (deliveryOffsetFromStart >= 7) {
    throw new Error(
      'orderingSchedule: delivery day would fall on/after the next session start; '
      + 'choose a delivery day after close but before the next weekly start',
    );
  }

  return s;
}

/** dayOfWeek: 0=Sun ... 6=Sat */
function getWarsawNow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    dayOfWeek: weekdayMap[get('weekday')] ?? 0,
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10),
  };
}

function fmt(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dayPhrase(dayIndex) {
  const name = DAY_FULL_UK[dayIndex];
  return `${/^[вф]/i.test(name) ? 'у' : 'в'} ${name}`;
}

function daysUntil(targetDay, targetMins, nowDOW, nowMins) {
  const diff = (targetDay - nowDOW + 7) % 7;
  return diff === 0 && nowMins >= targetMins ? 7 : diff;
}

function occurrenceLabel(targetDay, daysAhead) {
  if (daysAhead === 0) return { label: 'сьогодні', relative: 'today' };
  if (daysAhead === 1) return { label: 'завтра', relative: 'tomorrow' };
  return { label: dayPhrase(targetDay), relative: null };
}

/**
 * Open is inclusive, close is exclusive.
 */
function isOrderingOpen(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowWeek = toWeekMinute(current.dayOfWeek, current.hour, current.minute);
  const startWeek = toWeekMinute(s.startDay, s.startHour, s.startMinute);
  const duration = getWindowDurationMinutes(s);
  const elapsed = (nowWeek - startWeek + WEEK_MINUTES) % WEEK_MINUTES;
  const isOpen = elapsed < duration;

  const nowMins = current.hour * 60 + current.minute;
  const startAhead = occurrenceLabel(
    s.startDay,
    daysUntil(s.startDay, s.startHour * 60 + s.startMinute, current.dayOfWeek, nowMins),
  );
  const endAhead = occurrenceLabel(
    s.endDay,
    daysUntil(s.endDay, s.endHour * 60 + s.endMinute, current.dayOfWeek, nowMins),
  );
  const opensPhrase = `${startAhead.label} о ${fmt(s.startHour, s.startMinute)}`;
  const closesPhrase = `${endAhead.label} о ${fmt(s.endHour, s.endMinute)}`;

  return {
    isOpen,
    message: isOpen
      ? `Закривається ${closesPhrase}`
      : `Замовлення відкриються ${opensPhrase}, закриються ${closesPhrase}`,
  };
}

function getWindowDescription(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const openAhead = occurrenceLabel(
    s.startDay,
    daysUntil(s.startDay, s.startHour * 60 + s.startMinute, current.dayOfWeek, nowMins),
  );
  const closeAhead = occurrenceLabel(
    s.endDay,
    daysUntil(s.endDay, s.endHour * 60 + s.endMinute, current.dayOfWeek, nowMins),
  );

  return {
    openDay: s.startDay,
    closeDay: s.endDay,
    openTime: fmt(s.startHour, s.startMinute),
    closeTime: fmt(s.endHour, s.endMinute),
    openDayName: DAY_SHORT_UK[s.startDay],
    closeDayName: DAY_SHORT_UK[s.endDay],
    openDayNameFull: DAY_FULL_UK[s.startDay],
    closeDayNameFull: DAY_FULL_UK[s.endDay],
    openLabel: openAhead.label,
    openRelative: openAhead.relative,
    closeLabel: closeAhead.label,
    closeRelative: closeAhead.relative,
  };
}

/** Converts a Warsaw wall-clock date/time to UTC. */
const warsawPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function wallPartsAt(utcMs) {
  const parts = warsawPartsFormatter.formatToParts(new Date(utcMs));
  const g = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let readHour = g('hour');
  if (readHour === 24) readHour = 0;
  const out = { year: g('year'), month: g('month'), day: g('day'), hour: readHour, minute: g('minute') };
  out.wallMs = Date.UTC(out.year, out.month - 1, out.day, out.hour, out.minute);
  return out;
}

function timezoneOffsetAt(utcMs) {
  return wallPartsAt(utcMs).wallMs - utcMs;
}

/**
 * Converts a Warsaw wall-clock date/time to UTC with deterministic DST rules.
 * - autumn overlap (02:xx occurs twice): choose the EARLIER occurrence;
 * - spring gap (02:xx does not exist): move forward by the DST gap, e.g.
 *   02:30 -> 03:30. This matches the usual "compatible" calendar policy.
 */
function warsawWallClockToUTC(year, month, day, hour, minute) {
  const desiredWallMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([
    timezoneOffsetAt(desiredWallMs - 12 * 60 * 60 * 1000),
    timezoneOffsetAt(desiredWallMs),
    timezoneOffsetAt(desiredWallMs + 12 * 60 * 60 * 1000),
  ]);

  const candidates = [...offsets].map((offsetMs) => {
    const utcMs = desiredWallMs - offsetMs;
    const local = wallPartsAt(utcMs);
    return { utcMs, localWallMs: local.wallMs };
  });

  const exact = candidates
    .filter((candidate) => candidate.localWallMs === desiredWallMs)
    .sort((a, b) => a.utcMs - b.utcMs);
  if (exact.length) return new Date(exact[0].utcMs);

  // Non-existent spring-forward wall time. Prefer the candidate that lands
  // just AFTER the requested local time; using the pre-transition offset keeps
  // the minute component and advances by exactly the DST gap.
  const after = candidates
    .filter((candidate) => candidate.localWallMs > desiredWallMs)
    .sort((a, b) => (a.localWallMs - desiredWallMs) - (b.localWallMs - desiredWallMs));
  if (after.length) return new Date(after[0].utcMs);

  // Defensive fallback for an exotic timezone rule: choose the closest mapping.
  candidates.sort((a, b) => Math.abs(a.localWallMs - desiredWallMs) - Math.abs(b.localWallMs - desiredWallMs));
  return new Date(candidates[0].utcMs);
}

function addDaysToDateParts(year, month, day, delta) {
  const target = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
  };
}

function formatDateParts({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateString(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!year || !month || !day) throw new Error(`orderingSchedule: invalid openDate '${dateString}'`);
  return { year, month, day };
}

/** Most recent occurrence of the group's explicit start moment. */
function getOrderingWindowOpenAt(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const startMins = s.startHour * 60 + s.startMinute;
  let daysBack = (current.dayOfWeek - s.startDay + 7) % 7;
  if (daysBack === 0 && nowMins < startMins) daysBack = 7;
  const target = addDaysToDateParts(current.year, current.month, current.day, -daysBack);
  return warsawWallClockToUTC(target.year, target.month, target.day, s.startHour, s.startMinute);
}

/** Warsaw YYYY-MM-DD of the current cycle's start day. */
function getOpenDateWarsaw(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const startMins = s.startHour * 60 + s.startMinute;
  let daysBack = (current.dayOfWeek - s.startDay + 7) % 7;
  if (daysBack === 0 && nowMins < startMins) daysBack = 7;
  return formatDateParts(addDaysToDateParts(current.year, current.month, current.day, -daysBack));
}


/** Next future occurrence of the explicit start moment. */
function getNextOrderingWindowOpenAt(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const startMins = s.startHour * 60 + s.startMinute;
  let daysAhead = (s.startDay - current.dayOfWeek + 7) % 7;
  if (daysAhead === 0 && nowMins >= startMins) daysAhead = 7;
  const target = addDaysToDateParts(current.year, current.month, current.day, daysAhead);
  return warsawWallClockToUTC(target.year, target.month, target.day, s.startHour, s.startMinute);
}

/** Next future occurrence of the explicit close moment. */
function getOrderingWindowCloseAt(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const endMins = s.endHour * 60 + s.endMinute;
  let daysAhead = (s.endDay - current.dayOfWeek + 7) % 7;
  if (daysAhead === 0 && nowMins >= endMins) daysAhead = 7;
  const target = addDaysToDateParts(current.year, current.month, current.day, daysAhead);
  return warsawWallClockToUTC(target.year, target.month, target.day, s.endHour, s.endMinute);
}

/** Most recent past occurrence of the explicit close moment. */
function getPreviousOrderingCloseAt(schedule, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  const nowMins = current.hour * 60 + current.minute;
  const endMins = s.endHour * 60 + s.endMinute;
  let daysBack = (current.dayOfWeek - s.endDay + 7) % 7;
  if (daysBack === 0 && nowMins < endMins) daysBack = 7;
  const target = addDaysToDateParts(current.year, current.month, current.day, -daysBack);
  return warsawWallClockToUTC(target.year, target.month, target.day, s.endHour, s.endMinute);
}

/**
 * Exact boundaries for a session identified by its start-day Warsaw date.
 * This is stable even if called after the cycle closed.
 */
function getOrderingWindowBoundsForOpenDate(openDate, schedule) {
  const s = normalizeOrderingSchedule(schedule);
  const startDate = parseDateString(openDate);
  const startAt = warsawWallClockToUTC(
    startDate.year, startDate.month, startDate.day, s.startHour, s.startMinute,
  );
  const startMins = s.startHour * 60 + s.startMinute;
  const endMins = s.endHour * 60 + s.endMinute;
  let closeOffsetDays = (s.endDay - s.startDay + 7) % 7;
  if (closeOffsetDays === 0 && endMins <= startMins) closeOffsetDays = 7;
  const closeDate = addDaysToDateParts(startDate.year, startDate.month, startDate.day, closeOffsetDays);
  const closeAt = warsawWallClockToUTC(
    closeDate.year, closeDate.month, closeDate.day, s.endHour, s.endMinute,
  );
  return { openAt: startAt, closeAt };
}

/**
 * Calendar delivery date for a concrete ordering session.
 *
 * Delivery weekday is independent from orderingSchedule.endDay. The delivery
 * belonging to a session is the FIRST occurrence of DeliveryGroup.dayOfWeek on
 * or after that session's close calendar day. This guarantees that a session
 * can never be assigned to a delivery date that is already in the past when
 * ordering closes.
 *
 * Example: start Tue -> close Thu -> delivery Mon = following Monday.
 */
function getSessionDeliveryDate(openDate, deliveryDayOfWeek, schedule) {
  const deliveryDay = Number(deliveryDayOfWeek);
  const s = validateOrderingScheduleDeliveryDay(schedule, deliveryDay);

  const startDate = parseDateString(openDate);
  const startMins = s.startHour * 60 + s.startMinute;
  const endMins = s.endHour * 60 + s.endMinute;

  let closeOffsetDays = (s.endDay - s.startDay + 7) % 7;
  if (closeOffsetDays === 0 && endMins <= startMins) closeOffsetDays = 7;

  const deliveryOffsetAfterClose = (deliveryDay - s.endDay + 7) % 7;
  return formatDateParts(addDaysToDateParts(
    startDate.year,
    startDate.month,
    startDate.day,
    closeOffsetDays + deliveryOffsetAfterClose,
  ));
}

function isOrderingOpeningSoon(schedule, withinMinutes = 240, now = new Date()) {
  const s = normalizeOrderingSchedule(schedule);
  const current = getWarsawNow(now);
  if (current.dayOfWeek !== s.startDay) return false;
  const minsUntil = (s.startHour * 60 + s.startMinute) - (current.hour * 60 + current.minute);
  return minsUntil > 0 && minsUntil <= withinMinutes;
}

module.exports = {
  isOrderingOpen,
  isOrderingOpeningSoon,
  getWindowDescription,
  getWarsawNow,
  getOrderingWindowOpenAt,
  getNextOrderingWindowOpenAt,
  getOrderingWindowCloseAt,
  getPreviousOrderingCloseAt,
  getOpenDateWarsaw,
  getOrderingWindowBoundsForOpenDate,
  warsawWallClockToUTC,
  getSessionDeliveryDate,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
  getWindowDurationMinutes,
  TIMEZONE,
  DAY_SHORT_UK,
  DAY_FULL_UK,
  ALLOWED_MINUTES,
};
