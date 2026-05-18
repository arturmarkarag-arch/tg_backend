'use strict';

/**
 * Rounds a monetary amount to 2 decimal places (whole cents), killing binary
 * float artifacts like 19.99 * 3 === 59.96999999999999. Use at every point an
 * order/receipt total is computed or adjusted so stored and displayed amounts
 * are always exact cents.
 */
function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

module.exports = { roundMoney };
