'use strict';

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Decimal value must be finite');
    return String(value);
  }
  return String(value).trim();
}

function parseDecimal(value, { maxScale = 8, allowNegative = false, field = 'decimal' } = {}) {
  const raw = asText(value);
  if (!raw) return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) throw new TypeError(`${field} must be a decimal value`);

  let sign = 1;
  let body = raw;
  if (body[0] === '+' || body[0] === '-') {
    if (body[0] === '-') sign = -1;
    body = body.slice(1);
  }
  if (sign < 0 && !allowNegative) throw new TypeError(`${field} must not be negative`);

  let [whole, fraction = ''] = body.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  if (fraction.length > maxScale) throw new TypeError(`${field} has too many decimal places`);
  fraction = fraction.replace(/0+$/, '');

  const normalized = `${sign < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  return { sign, whole, fraction, normalized };
}

function normalizeDecimal(value, options = {}) {
  return parseDecimal(value, options)?.normalized || '';
}

function decimalToScaledInt(value, scale, { allowNegative = false, field = 'decimal' } = {}) {
  const parsed = parseDecimal(value, { maxScale: scale, allowNegative, field });
  if (!parsed) return null;
  const fraction = parsed.fraction.padEnd(scale, '0');
  const digits = `${parsed.whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(parsed.sign) * BigInt(digits);
}

function scaledIntToDecimal(value, scale) {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const digits = abs.toString().padStart(scale + 1, '0');
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale) : '';
  return `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`;
}

function normalizeMoney(value, { allowNegative = false, field = 'money' } = {}) {
  const scaled = decimalToScaledInt(value, 2, { allowNegative, field });
  if (scaled === null) return '';
  return scaledIntToDecimal(scaled, 2);
}

function normalizeQuantity(value, { field = 'quantity' } = {}) {
  const parsed = parseDecimal(value, { maxScale: 6, allowNegative: false, field });
  if (!parsed) return '';
  if (decimalToScaledInt(parsed.normalized, 6, { field }) <= 0n) throw new TypeError(`${field} must be greater than zero`);
  return parsed.normalized;
}

function addMoney(values = []) {
  const total = values.reduce((sum, value) => {
    const scaled = decimalToScaledInt(value, 2, { allowNegative: true, field: 'money' });
    if (scaled === null) throw new TypeError('Cannot add empty money value');
    return sum + scaled;
  }, 0n);
  return scaledIntToDecimal(total, 2);
}

function moneyEquals(left, right) {
  try {
    const a = decimalToScaledInt(left, 2, { allowNegative: true, field: 'money' });
    const b = decimalToScaledInt(right, 2, { allowNegative: true, field: 'money' });
    return a !== null && b !== null && a === b;
  } catch (_) {
    return false;
  }
}

module.exports = {
  normalizeDecimal,
  normalizeMoney,
  normalizeQuantity,
  decimalToScaledInt,
  scaledIntToDecimal,
  addMoney,
  moneyEquals,
};
