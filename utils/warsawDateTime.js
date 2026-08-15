'use strict';

const { TIMEZONE, warsawWallClockToUTC } = require('./orderingSchedule');

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dateTimePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDateKey(value) {
  const match = DATE_KEY_RE.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function addDaysToDateKey(value, delta) {
  const parts = parseDateKey(value);
  if (!parts || !Number.isInteger(delta)) return '';
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function formatWarsawDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = {};
  for (const part of dateKeyFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatWarsawDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = {};
  for (const part of dateTimePartsFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.day}.${parts.month}.${parts.year} ${hour}:${parts.minute}`;
}

function warsawDateKeyToUtcStart(value) {
  const parts = parseDateKey(value);
  if (!parts) return null;
  return warsawWallClockToUTC(parts.year, parts.month, parts.day, 0, 0);
}

function warsawDateKeyToUtcRange(value) {
  const start = warsawDateKeyToUtcStart(value);
  if (!start) return null;
  const nextKey = addDaysToDateKey(value, 1);
  const endExclusive = warsawDateKeyToUtcStart(nextKey);
  return { start, endExclusive };
}

/**
 * Mongo range for YYYY-MM-DD query params interpreted as Warsaw calendar days.
 * Uses an exclusive next-midnight boundary so DST days may be 23/25 hours
 * without leaking records from the adjacent local day.
 */
function buildWarsawDateRange({ dateFrom = '', dateTo = '' } = {}) {
  const range = {};
  const from = warsawDateKeyToUtcStart(dateFrom);
  const to = warsawDateKeyToUtcRange(dateTo);
  if (from) range.$gte = from;
  if (to) range.$lt = to.endExclusive;
  return range;
}

module.exports = {
  TIMEZONE,
  parseDateKey,
  addDaysToDateKey,
  formatWarsawDateKey,
  formatWarsawDateTime,
  warsawDateKeyToUtcStart,
  warsawDateKeyToUtcRange,
  buildWarsawDateRange,
};
