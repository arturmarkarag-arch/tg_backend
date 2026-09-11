'use strict';

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function issue(code, message, level = 'error', meta = {}) {
  return { code, level, message, ...meta };
}

function titleWordCount(value) {
  return text(value, 1000).split(/\s+/).filter(Boolean).length;
}

function effectivePrice(product, listing) {
  const mode = listing?.price?.mode || 'inherit';
  const rawValue = mode === 'override' ? listing?.price?.value : product?.basePrice;
  const value = Number(rawValue || 0);
  const currency = text(
    mode === 'override' ? (listing?.price?.currency || product?.currency || 'PLN') : (product?.currency || 'PLN'),
    10,
  ).toUpperCase() || 'PLN';
  return { mode, value: Number.isFinite(value) ? value : 0, currency };
}

function effectiveStock(product, listing, reservation = null) {
  const inventoryOnHand = Math.max(0, Math.floor(Number(product?.availableStock || 0)));
  const reservedUnits = Math.max(0, Math.floor(Number(reservation?.held || 0)));
  const source = Math.max(0, inventoryOnHand - reservedUnits);
  const mode = listing?.stock?.mode || 'inherit';
  const buffer = Math.max(0, Math.floor(Number(listing?.stock?.buffer || 0)));
  const inherited = Math.max(0, source - buffer);
  if (mode === 'fixed') {
    const requested = Math.max(0, Math.floor(Number(listing?.stock?.fixedQuantity || 0)));
    return {
      mode,
      inventoryOnHand,
      physicalSource: inventoryOnHand,
      reservedUnits,
      source,
      buffer,
      requested,
      available: Math.min(inherited, requested),
      clamped: requested > inherited,
    };
  }
  if (mode === 'capped') {
    const maxQuantity = Math.max(0, Math.floor(Number(listing?.stock?.maxQuantity || 0)));
    return { mode, inventoryOnHand, physicalSource: inventoryOnHand, reservedUnits, source, buffer, cappedAt: maxQuantity, available: Math.min(inherited, maxQuantity), clamped: false };
  }
  return { mode: 'inherit', inventoryOnHand, physicalSource: inventoryOnHand, reservedUnits, source, buffer, available: inherited, clamped: false };
}

function isLikelyGtin(value) {
  const normalized = text(value, 120).replace(/\s+/g, '');
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(normalized);
}

module.exports = {
  text,
  issue,
  titleWordCount,
  effectivePrice,
  effectiveStock,
  isLikelyGtin,
};
