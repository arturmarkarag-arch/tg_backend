'use strict';

/**
 * Ordering window logic for delivery groups.
 *
 * Polish timezone (Europe/Warsaw) is used throughout.
 * DST is handled automatically by the Intl API.
 *
 * Schedule:
 *   Ordering OPENS  — the day before delivery at 16:00, but if that day is Sunday
 *                    then Saturday is used instead (no ordering on Sundays).
 *   Ordering CLOSES — the delivery day itself at 07:30 Warsaw time
 *
 * Example:
 *   Delivery Monday  (dayOfWeek=1) → day-before = Sun → skip → open Sat 16:00, close Mon 07:30
 *   Delivery Tuesday (dayOfWeek=2) → day-before = Mon → open Mon 16:00, close Tue 07:30
 *   Delivery Thursday(dayOfWeek=4) → day-before = Wed → open Wed 16:00, close Thu 07:30
 */

const TIMEZONE = 'Europe/Warsaw';

const OPEN_HOUR = 16;
const OPEN_MINUTE = 0;
const CLOSE_HOUR = 7;
const CLOSE_MINUTE = 30;

const DAY_SHORT_UK = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAY_FULL_UK  = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', "п'ятницю", 'суботу'];

/**
 * Returns current day-of-week, hour and minute in Warsaw timezone.
 * dayOfWeek: 0=Sun, 1=Mon, …, 6=Sat
 */
function getWarsawNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',  // Mon, Tue …
    hour:    '2-digit',
    minute:  '2-digit',
    hour12:  false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[get('weekday')] ?? 0;

  // hour12:false returns '24' for midnight on some platforms — normalise
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);

  return { dayOfWeek, hour, minute };
}

/**
 * Formats a time as "16:00" (no AM/PM).
 */
function fmt(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Checks whether ordering is currently open for a delivery group.
 *
 * @param {number} deliveryDayOfWeek  0=Sun … 6=Sat  (the day the warehouse collects)
 * @param {{ openHour?: number, openMinute?: number, closeHour?: number, closeMinute?: number }} [schedule]
 * @returns {{ isOpen: boolean, message: string }}
 */
function isOrderingOpen(deliveryDayOfWeek, schedule = {}) {
  const openHour    = schedule.openHour    ?? OPEN_HOUR;
  const openMinute  = schedule.openMinute  ?? OPEN_MINUTE;
  const closeHour   = schedule.closeHour   ?? CLOSE_HOUR;
  const closeMinute = schedule.closeMinute ?? CLOSE_MINUTE;

  const { dayOfWeek, hour, minute } = getWarsawNow();

  // Day before delivery; if that falls on Sunday (0) — use Saturday (6) instead
  const dayBefore = (deliveryDayOfWeek - 1 + 7) % 7;
  const openDay  = dayBefore === 0 ? 6 : dayBefore;
  const closeDay = deliveryDayOfWeek;

  const nowMins   = hour * 60 + minute;
  const openMins  = openHour  * 60 + openMinute;
  const closeMins = closeHour * 60 + closeMinute;

  // --- same day as OPEN day ---
  if (dayOfWeek === openDay) {
    if (nowMins >= openMins) {
      return {
        isOpen: true,
        message: `Прийом замовлень відкрито до ${DAY_SHORT_UK[closeDay]} ${fmt(closeHour, closeMinute)}`,
      };
    }
    return {
      isOpen: false,
      message: `Прийом замовлень відкриється сьогодні о ${fmt(openHour, openMinute)}`,
    };
  }

  // --- same day as CLOSE day ---
  if (dayOfWeek === closeDay) {
    if (nowMins < closeMins) {
      return {
        isOpen: true,
        message: `Прийом замовлень відкрито. Закривається сьогодні о ${fmt(closeHour, closeMinute)}`,
      };
    }
    return {
      isOpen: false,
      message: `Прийом замовлень закрито. Наступне вікно — ${DAY_SHORT_UK[openDay]} о ${fmt(openHour, openMinute)}`,
    };
  }

  // --- any other day ---
  // Check if we're inside the open window (between openDay+openTime and closeDay+closeTime).
  // The window can span multiple days (e.g. Sat 16:00 → Mon 07:30 for Monday delivery).
  // We check: is current day strictly between openDay and closeDay (mod 7)?
  const daysFromOpen = (dayOfWeek - openDay + 7) % 7;
  const daysToClose  = (closeDay - dayOfWeek + 7) % 7;
  // Window length in days (openDay → closeDay)
  const windowDays = (closeDay - openDay + 7) % 7;

  if (daysFromOpen > 0 && daysFromOpen <= windowDays && daysToClose > 0) {
    // We're on a day strictly inside the open window
    return {
      isOpen: true,
      message: `Прийом замовлень відкрито. Закривається у ${DAY_SHORT_UK[closeDay]} о ${fmt(closeHour, closeMinute)}`,
    };
  }

  return {
    isOpen: false,
    message: `Прийом замовлень відкрито з ${DAY_SHORT_UK[openDay]} ${fmt(openHour, openMinute)} по ${DAY_SHORT_UK[closeDay]} ${fmt(closeHour, closeMinute)}`,
  };
}

/**
 * Returns window times for display purposes.
 */
function getWindowDescription(deliveryDayOfWeek, schedule = {}) {
  const openHour    = schedule.openHour    ?? OPEN_HOUR;
  const openMinute  = schedule.openMinute  ?? OPEN_MINUTE;
  const closeHour   = schedule.closeHour   ?? CLOSE_HOUR;
  const closeMinute = schedule.closeMinute ?? CLOSE_MINUTE;

  const dayBefore = (deliveryDayOfWeek - 1 + 7) % 7;
  const openDay  = dayBefore === 0 ? 6 : dayBefore;
  const closeDay = deliveryDayOfWeek;
  return {
    openDay,
    closeDay,
    openTime:  fmt(openHour, openMinute),
    closeTime: fmt(closeHour, closeMinute),
    openDayName:  DAY_SHORT_UK[openDay],
    closeDayName: DAY_SHORT_UK[closeDay],
    openDayNameFull:  DAY_FULL_UK[openDay],
    closeDayNameFull: DAY_FULL_UK[closeDay],
  };
}

/**
 * Converts a wall-clock date/time in Warsaw timezone to a UTC Date.
 * Uses a one-step offset approximation — accurate for all non-DST-transition moments.
 */
function warsawWallClockToUTC(year, month, day, hour, minute) {
  // Estimate UTC by assuming UTC+1 (Warsaw winter time)
  const approx = new Date(Date.UTC(year, month - 1, day, hour - 1, minute));

  // Find the actual Warsaw offset for this approximate UTC moment
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(approx);
  const g = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);

  // offsetMs = (Warsaw wall clock read as UTC) − actual UTC
  const warsawAsUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  const offsetMs = warsawAsUTC - approx.getTime();

  // target UTC = target Warsaw wall clock (as UTC) − offset
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMs);
}

/**
 * Returns the UTC Date when the current ordering window opened for the given group.
 * This is the most recent past occurrence of (openDay at openHour:openMinute Warsaw time).
 *
 * @param {number} deliveryDayOfWeek  0=Sun … 6=Sat
 * @param {{ openHour?: number, openMinute?: number }} [schedule]
 * @returns {Date}
 */
function getOrderingWindowOpenAt(deliveryDayOfWeek, schedule = {}) {
  const openHour   = schedule.openHour   ?? OPEN_HOUR;
  const openMinute = schedule.openMinute ?? OPEN_MINUTE;

  // Which weekday does the window open on? (day before delivery; Sunday → Saturday)
  const dayBefore = (deliveryDayOfWeek - 1 + 7) % 7;
  const openDay   = dayBefore === 0 ? 6 : dayBefore;

  const { dayOfWeek: nowDOW, hour: nowHour, minute: nowMinute } = getWarsawNow();
  const nowMins  = nowHour * 60 + nowMinute;
  const openMins = openHour * 60 + openMinute;

  // How many days back is the last occurrence of openDay?
  let daysBack = (nowDOW - openDay + 7) % 7;
  // If today IS openDay but we haven't passed openTime yet → look back a full week
  if (daysBack === 0 && nowMins < openMins) {
    daysBack = 7;
  }

  // Get current Warsaw calendar date
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const gd = (t) => parseInt(dateParts.find((p) => p.type === t)?.value ?? '0', 10);

  // Subtract daysBack; Date.UTC handles month/year rollover automatically
  const target = new Date(Date.UTC(gd('year'), gd('month') - 1, gd('day') - daysBack));

  return warsawWallClockToUTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    openHour,
    openMinute,
  );
}

/**
 * Returns a stable string ID for the current ordering session of a delivery group.
 * Format: `<groupId>:<windowOpenAt ISO string>`
 *
 * @param {string} groupId
 * @param {number} deliveryDayOfWeek  0=Sun … 6=Sat
 * @param {{ openHour?: number, openMinute?: number }} [schedule]
 * @returns {string}
 */
function getCurrentOrderingSessionId(groupId, deliveryDayOfWeek, schedule = {}) {
  const windowOpenAt = getOrderingWindowOpenAt(deliveryDayOfWeek, schedule);
  return `${groupId}:${windowOpenAt.toISOString()}`;
}

module.exports = { isOrderingOpen, getWindowDescription, getWarsawNow, getOrderingWindowOpenAt, getCurrentOrderingSessionId, DAY_SHORT_UK, DAY_FULL_UK };
