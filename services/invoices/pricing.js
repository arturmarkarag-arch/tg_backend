'use strict';

const {
  normalizeDecimal,
  normalizeMoney,
  decimalToScaledInt,
  scaledIntToDecimal,
  addMoney,
  moneyEquals,
} = require('./decimal');

const ZERO_VAT_CODES = new Set(['0', '0%', 'zw', 'np', 'oo']);

function decimalFraction(value, { maxScale = 8, allowNegative = true, field = 'decimal' } = {}) {
  const normalized = normalizeDecimal(value, { maxScale, allowNegative, field });
  if (!normalized) return null;
  const negative = normalized.startsWith('-');
  const body = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ''] = body.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}` || '0') * (negative ? -1n : 1n);
  return { normalized, numerator, denominator };
}

function roundFractionToMoney(numerator, denominator) {
  if (denominator <= 0n) throw new TypeError('denominator must be positive');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const scaled = abs * 100n;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  if (negative) quotient = -quotient;
  return scaledIntToDecimal(quotient, 2);
}

function multiplyToMoney(left, right, { leftScale = 6, rightScale = 8, field = 'amount' } = {}) {
  const a = decimalFraction(left, { maxScale: leftScale, allowNegative: true, field: `${field}.left` });
  const b = decimalFraction(right, { maxScale: rightScale, allowNegative: true, field: `${field}.right` });
  if (!a || !b) return '';
  return roundFractionToMoney(a.numerator * b.numerator, a.denominator * b.denominator);
}

function multiplyMoneyByRate(amount, rate) {
  const money = decimalFraction(normalizeMoney(amount, { allowNegative: true, field: 'amount' }), {
    maxScale: 2,
    allowNegative: true,
    field: 'amount',
  });
  const vatRate = decimalFraction(rate, { maxScale: 4, allowNegative: false, field: 'vat.rate' });
  if (!money || !vatRate) return '';
  return roundFractionToMoney(
    money.numerator * vatRate.numerator,
    money.denominator * vatRate.denominator * 100n,
  );
}

function deriveNetFromGross(gross, rate) {
  const money = decimalFraction(normalizeMoney(gross, { allowNegative: true, field: 'gross' }), {
    maxScale: 2,
    allowNegative: true,
    field: 'gross',
  });
  const vatRate = decimalFraction(rate, { maxScale: 4, allowNegative: false, field: 'vat.rate' });
  if (!money || !vatRate) return '';
  const hundred = 100n * vatRate.denominator;
  const denominator = vatRate.denominator * 100n + vatRate.numerator;
  return roundFractionToMoney(money.numerator * hundred, money.denominator * denominator);
}

function subtractMoney(left, right) {
  const a = decimalToScaledInt(left, 2, { allowNegative: true, field: 'money.left' });
  const b = decimalToScaledInt(right, 2, { allowNegative: true, field: 'money.right' });
  if (a === null || b === null) return '';
  return scaledIntToDecimal(a - b, 2);
}

function effectiveVatRate(vat = {}) {
  if (vat.rate !== '' && vat.rate !== null && vat.rate !== undefined) {
    return normalizeDecimal(vat.rate, { maxScale: 4, allowNegative: false, field: 'vat.rate' });
  }
  const code = String(vat.code || '').trim().toLowerCase();
  if (!code) return '';
  if (/^\d+(?:\.\d+)?%?$/.test(code)) {
    return normalizeDecimal(code.replace(/%$/, ''), { maxScale: 4, allowNegative: false, field: 'vat.code' });
  }
  if (ZERO_VAT_CODES.has(code)) return '0';
  return '';
}

function calculateItemAmounts(item = {}) {
  if (!item.quantity || item.unitPrice === '' || item.unitPrice === null || item.unitPrice === undefined) return null;
  if (!['net', 'gross'].includes(item.priceBasis)) return null;
  const rate = effectiveVatRate(item.vat || {});
  if (rate === '') return null;

  const base = multiplyToMoney(item.quantity, item.unitPrice, { field: 'line' });
  if (!base) return null;

  if (item.priceBasis === 'net') {
    const net = base;
    const vat = multiplyMoneyByRate(net, rate);
    const gross = addMoney([net, vat]);
    return { net, vat, gross };
  }

  const gross = base;
  const net = deriveNetFromGross(gross, rate);
  const vat = subtractMoney(gross, net);
  return { net, vat, gross };
}

function completeItemAmounts(item = {}) {
  const explicit = item.amounts || {};
  const calculated = calculateItemAmounts(item);
  if (!calculated) return { ...explicit };
  return {
    net: explicit.net || calculated.net,
    vat: explicit.vat || calculated.vat,
    gross: explicit.gross || calculated.gross,
  };
}

function itemAmountsMatchPricing(item = {}) {
  const calculated = calculateItemAmounts(item);
  if (!calculated) return null;
  const amounts = item.amounts || {};
  if (!amounts.net || !amounts.vat || !amounts.gross) return false;
  return moneyEquals(calculated.net, amounts.net)
    && moneyEquals(calculated.vat, amounts.vat)
    && moneyEquals(calculated.gross, amounts.gross);
}

module.exports = {
  ZERO_VAT_CODES,
  effectiveVatRate,
  calculateItemAmounts,
  completeItemAmounts,
  itemAmountsMatchPricing,
  multiplyToMoney,
};
