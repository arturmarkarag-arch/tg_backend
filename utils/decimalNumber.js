'use strict';

/**
 * Parse decimal input independently of client/browser locale.
 * Accepts both comma and dot decimal separators.
 */
function parseDecimalNumber(value) {
  if (value == null) return Number.NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

module.exports = { parseDecimalNumber };
