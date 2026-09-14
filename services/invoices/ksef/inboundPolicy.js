'use strict';

const crypto = require('crypto');

const SUBJECT_TYPE = 'Subject2';
const PAGE_SIZE = 250;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const PAGE_CONTINUE_MS = 4 * 60 * 1000;
const FETCH_TICK_MS = 90 * 1000;
const FETCH_LEASE_MS = 60 * 1000;
const SYNC_LEASE_MS = 2 * 60 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function minDate(left, right) {
  const a = asDate(left);
  const b = asDate(right);
  if (!a || !b) return a || b || null;
  return a.getTime() <= b.getTime() ? a : b;
}

function buildRequestedWindowEnd(from, now = new Date()) {
  const start = asDate(from);
  const current = asDate(now);
  if (!start || !current) return null;
  return new Date(Math.min(start.getTime() + MAX_WINDOW_MS, current.getTime()));
}

function effectiveWindowEnd(requestedTo, permanentStorageHwmDate) {
  return minDate(requestedTo, permanentStorageHwmDate);
}

function buildMetadataFilters({ from, to }) {
  const start = asDate(from);
  const end = asDate(to);
  if (!start || !end || end.getTime() < start.getTime()) throw new TypeError('Invalid PermanentStorage window');
  return {
    subjectType: SUBJECT_TYPE,
    dateRange: {
      dateType: 'PermanentStorage',
      from: start.toISOString(),
      to: end.toISOString(),
      restrictToPermanentStorageHwmDate: true,
    },
  };
}

function normalizeKsefNumber(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^(?=.{35,36}$)[0-9A-Z]+(?:-[0-9A-Z]+){3}$/.test(text) ? text : '';
}

function normalizeHashBase64(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) return '';
    return decoded.toString('base64');
  } catch (_) { return ''; }
}

function sha256Base64(bytes) { return crypto.createHash('sha256').update(bytes).digest('base64'); }
function sha256Hex(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function isFa3Xml(xml) {
  const text = String(xml || '');
  return /kodSystemowy\s*=\s*["']FA\s*\(3\)["']/i.test(text)
    || /http:\/\/crd\.gov\.pl\/wzor\/2025\/06\/25\/13775\//i.test(text);
}

function retryAfterMs(error) {
  const raw = error?.args?.retryAfter || error?.ksef?.retryAfter || '';
  const seconds = Number(String(raw).trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_MS, Math.ceil(seconds * 1000)) : 0;
}

function retryDelayMs(attempt, error, { floorMs = FETCH_TICK_MS } = {}) {
  const providerDelay = retryAfterMs(error);
  if (providerDelay) return Math.max(floorMs, providerDelay);
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(MAX_RETRY_MS, Math.max(floorMs, (2 ** Math.min(n - 1, 5)) * floorMs));
}

function syncKey(legalEntityId, environment) {
  return crypto.createHash('sha256').update(`ksef|${String(legalEntityId)}|${String(environment)}|${SUBJECT_TYPE}`, 'utf8').digest('hex');
}

module.exports = {
  SUBJECT_TYPE,
  PAGE_SIZE,
  MAX_WINDOW_MS,
  MIN_SYNC_INTERVAL_MS,
  PAGE_CONTINUE_MS,
  FETCH_TICK_MS,
  FETCH_LEASE_MS,
  SYNC_LEASE_MS,
  MAX_RETRY_MS,
  asDate,
  minDate,
  buildRequestedWindowEnd,
  effectiveWindowEnd,
  buildMetadataFilters,
  normalizeKsefNumber,
  normalizeHashBase64,
  sha256Base64,
  sha256Hex,
  isFa3Xml,
  retryAfterMs,
  retryDelayMs,
  syncKey,
};
