'use strict';

function compact(value) {
  return String(value ?? '').trim().replace(/[\s-]+/g, '').toUpperCase();
}

function normalizePolishNip(value) {
  const raw = compact(value).replace(/^PL/, '');
  return raw;
}

function isValidPolishNip(value) {
  const nip = normalizePolishNip(value);
  if (!/^\d{10}$/.test(nip)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(nip[index]), 0);
  const checksum = sum % 11;
  return checksum !== 10 && checksum === Number(nip[9]);
}

function normalizeTaxId(value, { countryCode = '', taxIdType = '' } = {}) {
  const country = String(countryCode || '').trim().toUpperCase();
  const type = String(taxIdType || '').trim().toLowerCase();
  if (country === 'PL' && type === 'nip') return normalizePolishNip(value);
  return compact(value);
}

module.exports = { normalizePolishNip, isValidPolishNip, normalizeTaxId };
