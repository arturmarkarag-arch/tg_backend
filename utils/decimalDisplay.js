'use strict';

/**
 * Canonical decimal display for user-visible numeric values:
 * - dot separator
 * - no locale grouping
 * - no artificial trailing zeroes
 * JavaScript Number already canonicalizes 1.50 to 1.5.
 */
function formatCompactDecimal(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : fallback;
}

module.exports = { formatCompactDecimal };
