'use strict';

const { getWarsawNow, warsawWallClockToUTC } = require('./orderingSchedule');

const RESUME_HOUR = 8;
const END_HOUR = 22;

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareLocalDate(a, b) {
  return localDateKey(a).localeCompare(localDateKey(b));
}

/**
 * Returns the single reminder slot that is CURRENT at `now`, or null.
 *
 * Rules:
 * - opening notification owns the exact session start; reminders begin one hour later;
 * - on the opening Warsaw day, reminders stay anchored to the session-start minute;
 * - every later Warsaw day resumes at 08:00 and runs hourly through 22:00;
 * - no new reminder event is created after the local 22:00 boundary;
 * - openAt/closeAt are persisted OrderingSession boundaries, never client time.
 *
 * The function intentionally returns only the current slot. After downtime we do
 * not burst-send every missed hourly reminder; the current interval is enough.
 */
function getCurrentOrderingReminderSlot({ openAt, closeAt, now = new Date() } = {}) {
  const open = new Date(openAt);
  const close = new Date(closeAt);
  const current = new Date(now);
  if ([open, close, current].some((d) => Number.isNaN(d.getTime()))) return null;
  if (current.getTime() < open.getTime() || current.getTime() >= close.getTime()) return null;

  const openLocal = getWarsawNow(open);
  const nowLocal = getWarsawNow(current);
  const dateCmp = compareLocalDate(nowLocal, openLocal);
  if (dateCmp < 0) return null;

  // Hard business window: after 22:00 Warsaw no NEW reminder is prepared.
  // At exactly 22:00 the 22:00 slot is allowed; at 22:01 it is not.
  if (nowLocal.hour > END_HOUR || (nowLocal.hour === END_HOUR && nowLocal.minute > 0)) return null;

  let slotAt = null;
  if (dateCmp === 0) {
    const openMinutes = openLocal.hour * 60 + openLocal.minute;
    const nowMinutes = nowLocal.hour * 60 + nowLocal.minute;
    const elapsedMinutes = nowMinutes - openMinutes;
    if (elapsedMinutes < 60) return null;
    const completedHours = Math.floor(elapsedMinutes / 60);
    const slotMinutes = openMinutes + completedHours * 60;
    const slotHour = Math.floor(slotMinutes / 60);
    const slotMinute = slotMinutes % 60;
    if (slotHour > END_HOUR || (slotHour === END_HOUR && slotMinute > 0)) return null;
    slotAt = warsawWallClockToUTC(openLocal.year, openLocal.month, openLocal.day, slotHour, slotMinute);
  } else {
    if (nowLocal.hour < RESUME_HOUR) return null;
    const slotHour = nowLocal.hour;
    if (slotHour > END_HOUR) return null;
    slotAt = warsawWallClockToUTC(nowLocal.year, nowLocal.month, nowLocal.day, slotHour, 0);
  }

  if (!slotAt || slotAt.getTime() <= open.getTime() || slotAt.getTime() >= close.getTime()) return null;
  if (slotAt.getTime() > current.getTime()) return null;
  return slotAt;
}

function reminderSlotKey(slotAt) {
  const date = new Date(slotAt);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  RESUME_HOUR,
  END_HOUR,
  getCurrentOrderingReminderSlot,
  reminderSlotKey,
  addLocalDays,
};
