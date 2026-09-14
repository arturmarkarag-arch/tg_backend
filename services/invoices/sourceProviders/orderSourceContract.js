'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');
const { stableStringify } = require('../stableJson');

const ORDER_SOURCE_CONTRACT_VERSION = 1;
const SOURCE_AUTHORITY = 'upstream_order';

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function decimalString(value, { allowNegative = false } = {}) {
  const n = finiteNumber(value);
  if (n === null || (!allowNegative && n < 0)) return '';
  const normalized = String(value).trim().replace(',', '.');
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return normalized.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
  return String(n);
}

function normalizeVat(value) {
  if (value && typeof value === 'object') {
    const code = text(value.code, 40).toLowerCase();
    const rate = decimalString(value.rate, { allowNegative: true });
    return { code: code || (rate ? rate : ''), rate: rate && Number(rate) >= 0 ? rate : '' };
  }
  const rateNumber = finiteNumber(value);
  if (rateNumber === null) return { code: '', rate: '' };
  if (rateNumber === -1) return { code: 'zw', rate: '' };
  if (rateNumber === -0.02) return { code: 'np', rate: '' };
  if (rateNumber === -0.03) return { code: 'oo', rate: '' };
  const rate = decimalString(value);
  return { code: rate, rate };
}

function normalizeAddress(raw = {}) {
  return {
    street: text(raw.street, 250),
    postalCode: text(raw.postalCode || raw.zipCode || raw.postcode, 30),
    city: text(raw.city, 120),
    countryCode: text(raw.countryCode, 2).toUpperCase(),
  };
}

function normalizeBuyer(raw = {}) {
  return {
    name: text(raw.name, 300),
    taxId: text(raw.taxId, 80),
    taxIdType: text(raw.taxIdType, 40).toLowerCase(),
    email: text(raw.email, 320).toLowerCase(),
    phone: text(raw.phone, 80),
    address: normalizeAddress(raw.address || {}),
  };
}

function normalizeOrderSourceSnapshot(raw = {}) {
  const items = Array.isArray(raw.items) ? raw.items.map((item = {}) => ({
    sourceLineId: text(item.sourceLineId || item.id, 160),
    productRef: text(item.productRef, 160),
    name: text(item.name, 500),
    quantity: decimalString(item.quantity),
    unit: text(item.unit, 40) || 'szt.',
    unitPriceGross: decimalString(item.unitPriceGross ?? item.grossPrice ?? item.unitPrice),
    currency: text(item.currency, 3).toUpperCase(),
    vat: normalizeVat(item.vat ?? item.vatRate),
    metadata: item.metadata && typeof item.metadata === 'object' ? { ...item.metadata } : {},
  })) : [];
  const deliveryGross = decimalString(raw.delivery?.gross ?? raw.delivery?.priceGross ?? '');

  return {
    contractVersion: ORDER_SOURCE_CONTRACT_VERSION,
    provider: text(raw.provider, 80).toLowerCase(),
    adapter: text(raw.adapter, 80).toLowerCase(),
    accountId: text(raw.accountId, 120),
    orderId: text(raw.orderId, 180),
    externalNumber: text(raw.externalNumber, 180),
    revision: text(raw.revision, 180),
    observedAt: text(raw.observedAt, 64),
    confirmed: raw.confirmed === true,
    invoiceRequested: raw.invoiceRequested === null || raw.invoiceRequested === undefined ? null : bool(raw.invoiceRequested),
    currency: text(raw.currency, 3).toUpperCase(),
    saleDate: text(raw.saleDate, 10),
    buyer: normalizeBuyer(raw.buyer || {}),
    items,
    delivery: {
      name: text(raw.delivery?.name, 300) || 'Dostawa',
      gross: deliveryGross,
      currency: text(raw.delivery?.currency, 3).toUpperCase(),
      vat: normalizeVat(raw.delivery?.vat ?? raw.delivery?.vatRate),
    },
    payment: {
      method: text(raw.payment?.method, 80).toLowerCase(),
      paid: raw.payment?.paid === true,
      paidAt: text(raw.payment?.paidAt, 64),
    },
    discountsPresent: raw.discountsPresent === true,
  };
}

function validateOrderSourceSnapshot(raw = {}, { requireInvoiceRequested = false } = {}) {
  const snapshot = normalizeOrderSourceSnapshot(raw);
  const blockers = [];
  if (!snapshot.provider) blockers.push('invoice_source_provider_required');
  if (!snapshot.adapter) blockers.push('invoice_source_adapter_required');
  if (!snapshot.accountId) blockers.push('invoice_source_account_id_required');
  if (!snapshot.orderId) blockers.push('invoice_source_order_id_required');
  if (!snapshot.confirmed) blockers.push('invoice_source_order_not_confirmed');
  if (requireInvoiceRequested && snapshot.invoiceRequested !== true) blockers.push('invoice_source_invoice_not_requested');
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) blockers.push('invoice_source_currency_required');
  if (!snapshot.buyer.name) blockers.push('invoice_source_buyer_name_required');
  if (!snapshot.buyer.address.street) blockers.push('invoice_source_buyer_street_required');
  if (!snapshot.buyer.address.postalCode) blockers.push('invoice_source_buyer_postal_code_required');
  if (!snapshot.buyer.address.city) blockers.push('invoice_source_buyer_city_required');
  if (!snapshot.buyer.address.countryCode) blockers.push('invoice_source_buyer_country_required');
  if (!snapshot.items.length) blockers.push('invoice_source_items_required');
  if (snapshot.discountsPresent) blockers.push('invoice_source_discounts_not_supported');

  snapshot.items.forEach((item, index) => {
    if (!item.sourceLineId) blockers.push(`invoice_source_item_${index}_id_required`);
    if (!item.name) blockers.push(`invoice_source_item_${index}_name_required`);
    if (!(Number(item.quantity) > 0)) blockers.push(`invoice_source_item_${index}_quantity_invalid`);
    if (item.unitPriceGross === '' || Number(item.unitPriceGross) < 0) blockers.push(`invoice_source_item_${index}_gross_price_required`);
    if (!item.vat.code) blockers.push(`invoice_source_item_${index}_vat_required`);
    if (item.currency && snapshot.currency && item.currency !== snapshot.currency) blockers.push(`invoice_source_item_${index}_currency_mismatch`);
  });

  if (snapshot.delivery.gross && Number(snapshot.delivery.gross) > 0) {
    if (snapshot.delivery.currency && snapshot.currency && snapshot.delivery.currency !== snapshot.currency) blockers.push('invoice_source_delivery_currency_mismatch');
    if (!snapshot.delivery.vat.code) blockers.push('invoice_source_delivery_vat_required');
  }

  return { snapshot, blockers: [...new Set(blockers)] };
}

function assertOrderSourceSnapshot(raw = {}, options = {}) {
  const result = validateOrderSourceSnapshot(raw, options);
  if (result.blockers.length) {
    throw appError('invoice_source_contract_invalid', {
      sourceProvider: result.snapshot.provider,
      sourceAccountId: result.snapshot.accountId,
      sourceOrderId: result.snapshot.orderId,
      blockers: result.blockers,
    });
  }
  return result.snapshot;
}

function snapshotHash(snapshot) {
  const canonical = normalizeOrderSourceSnapshot(snapshot);
  // observedAt is transport metadata, not a provider business fact. Including it
  // would make every exact re-read look stale even when the order is unchanged.
  delete canonical.observedAt;
  return crypto.createHash('sha256').update(stableStringify(canonical), 'utf8').digest('hex');
}

function buildInvoiceDraftFromOrderSnapshot(rawSnapshot = {}, input = {}) {
  const snapshot = assertOrderSourceSnapshot(rawSnapshot, {
    requireInvoiceRequested: input.requireInvoiceRequested === true,
  });
  const items = snapshot.items.map((item) => ({
    sourceLineId: item.sourceLineId,
    productRef: item.productRef,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPriceGross,
    priceBasis: 'gross',
    vat: item.vat,
    metadata: { ...item.metadata, sourceAuthority: SOURCE_AUTHORITY },
  }));
  if (snapshot.delivery.gross && Number(snapshot.delivery.gross) > 0) {
    items.push({
      sourceLineId: 'delivery',
      productRef: '',
      name: snapshot.delivery.name || 'Dostawa',
      quantity: '1',
      unit: 'szt.',
      unitPrice: snapshot.delivery.gross,
      priceBasis: 'gross',
      vat: snapshot.delivery.vat,
      metadata: { sourceAuthority: SOURCE_AUTHORITY, kind: 'delivery' },
    });
  }

  return {
    type: input.type || 'invoice',
    source: {
      provider: snapshot.provider,
      entityType: 'order',
      entityId: snapshot.orderId,
      externalNumber: snapshot.externalNumber || snapshot.orderId,
      metadata: {
        authority: SOURCE_AUTHORITY,
        adapter: snapshot.adapter,
        accountId: snapshot.accountId,
        orderId: snapshot.orderId,
        revision: snapshot.revision,
        observedAt: snapshot.observedAt,
        invoiceRequested: snapshot.invoiceRequested,
        snapshotSha256: snapshotHash(snapshot),
        contractVersion: ORDER_SOURCE_CONTRACT_VERSION,
      },
    },
    buyer: snapshot.buyer,
    issueDate: input.issueDate || '',
    saleDate: input.saleDate || snapshot.saleDate || '',
    currency: snapshot.currency,
    items,
    payment: {
      method: snapshot.payment.method || input.payment?.method || '',
      dueDate: input.payment?.dueDate || '',
      bankAccount: input.payment?.bankAccount || '',
      paid: snapshot.payment.paid,
      paidAt: snapshot.payment.paidAt,
    },
    references: {
      sourceOrder: {
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        orderId: snapshot.orderId,
        externalNumber: snapshot.externalNumber || '',
      },
    },
    notes: input.notes || '',
  };
}

module.exports = {
  ORDER_SOURCE_CONTRACT_VERSION,
  SOURCE_AUTHORITY,
  normalizeVat,
  normalizeOrderSourceSnapshot,
  validateOrderSourceSnapshot,
  assertOrderSourceSnapshot,
  snapshotHash,
  buildInvoiceDraftFromOrderSnapshot,
};
