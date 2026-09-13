'use strict';

const { addMoney, moneyEquals, normalizeDecimal, normalizeMoney, normalizeQuantity } = require('./decimal');
const { stableClone } = require('./stableJson');

const INVOICE_CORE_VERSION = 1;
const INVOICE_TYPES = Object.freeze({ INVOICE: 'invoice', CORRECTION: 'correction' });
const INVOICE_STATUSES = Object.freeze({ DRAFT: 'draft', FINALIZED: 'finalized' });
const PRICE_BASIS = Object.freeze({ NET: 'net', GROSS: 'gross', UNKNOWN: 'unknown' });

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function dateOnly(value, field) {
  const out = text(value, 10);
  if (!out) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) throw new TypeError(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${out}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== out) throw new TypeError(`${field} is invalid`);
  return out;
}

function normalizeAddress(raw = {}) {
  return {
    street: text(raw.street, 250),
    postalCode: text(raw.postalCode, 30),
    city: text(raw.city, 120),
    countryCode: text(raw.countryCode, 2).toUpperCase(),
  };
}

function normalizeParty(raw = {}) {
  return {
    legalEntityId: text(raw.legalEntityId, 120),
    name: text(raw.name, 300),
    taxId: text(raw.taxId, 80),
    taxIdType: text(raw.taxIdType, 40).toLowerCase(),
    email: text(raw.email, 320).toLowerCase(),
    phone: text(raw.phone, 80),
    address: normalizeAddress(raw.address || {}),
  };
}

function normalizeActor(raw = {}) {
  return {
    id: text(raw.id || raw.telegramId, 120),
    name: text(raw.name, 200),
    role: text(raw.role, 80),
  };
}

function normalizeSource(raw = {}) {
  return {
    provider: text(raw.provider, 80).toLowerCase(),
    entityType: text(raw.entityType, 80).toLowerCase(),
    entityId: text(raw.entityId, 160),
    externalNumber: text(raw.externalNumber, 160),
    metadata: stableClone(raw.metadata || {}),
  };
}

function normalizeVat(raw = {}) {
  const rate = raw.rate === '' || raw.rate === null || raw.rate === undefined
    ? ''
    : normalizeDecimal(raw.rate, { maxScale: 4, allowNegative: false, field: 'vat.rate' });
  return {
    code: text(raw.code, 40).toLowerCase(),
    rate,
  };
}

function normalizeAmounts(raw = {}) {
  return {
    net: raw.net === '' || raw.net === null || raw.net === undefined ? '' : normalizeMoney(raw.net, { allowNegative: true, field: 'amounts.net' }),
    vat: raw.vat === '' || raw.vat === null || raw.vat === undefined ? '' : normalizeMoney(raw.vat, { allowNegative: true, field: 'amounts.vat' }),
    gross: raw.gross === '' || raw.gross === null || raw.gross === undefined ? '' : normalizeMoney(raw.gross, { allowNegative: true, field: 'amounts.gross' }),
  };
}

function normalizeItem(raw = {}, index = 0) {
  const priceBasis = text(raw.priceBasis, 20).toLowerCase() || PRICE_BASIS.UNKNOWN;
  if (!Object.values(PRICE_BASIS).includes(priceBasis)) throw new TypeError(`items[${index}].priceBasis is invalid`);
  return {
    sourceLineId: text(raw.sourceLineId, 160),
    productRef: text(raw.productRef, 160),
    name: text(raw.name, 500),
    quantity: raw.quantity === '' || raw.quantity === null || raw.quantity === undefined
      ? ''
      : normalizeQuantity(raw.quantity, { field: `items[${index}].quantity` }),
    unit: text(raw.unit, 40) || 'szt.',
    unitPrice: raw.unitPrice === '' || raw.unitPrice === null || raw.unitPrice === undefined
      ? ''
      : normalizeDecimal(raw.unitPrice, { maxScale: 8, allowNegative: true, field: `items[${index}].unitPrice` }),
    priceBasis,
    vat: normalizeVat(raw.vat || {}),
    amounts: normalizeAmounts(raw.amounts || {}),
    metadata: stableClone(raw.metadata || {}),
  };
}

function normalizePayment(raw = {}) {
  return {
    method: text(raw.method, 80).toLowerCase(),
    dueDate: raw.dueDate ? dateOnly(raw.dueDate, 'payment.dueDate') : '',
    bankAccount: text(raw.bankAccount, 80).replace(/\s+/g, ''),
    paid: raw.paid === true,
    paidAt: raw.paidAt ? String(raw.paidAt) : '',
  };
}

function deriveTotals(items) {
  if (!items.length || items.some((item) => !item.amounts.net || !item.amounts.vat || !item.amounts.gross)) {
    return { net: '', vat: '', gross: '' };
  }
  return {
    net: addMoney(items.map((item) => item.amounts.net)),
    vat: addMoney(items.map((item) => item.amounts.vat)),
    gross: addMoney(items.map((item) => item.amounts.gross)),
  };
}

function normalizeInvoiceDraft(raw = {}) {
  const type = text(raw.type, 40).toLowerCase() || INVOICE_TYPES.INVOICE;
  if (!Object.values(INVOICE_TYPES).includes(type)) throw new TypeError('Invoice type is invalid');
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [];
  const derivedTotals = deriveTotals(items);
  const explicitTotals = normalizeAmounts(raw.totals || {});
  const totals = {
    net: explicitTotals.net || derivedTotals.net,
    vat: explicitTotals.vat || derivedTotals.vat,
    gross: explicitTotals.gross || derivedTotals.gross,
  };

  return {
    coreVersion: INVOICE_CORE_VERSION,
    type,
    source: normalizeSource(raw.source || {}),
    seller: normalizeParty(raw.seller || {}),
    buyer: normalizeParty(raw.buyer || {}),
    recipient: raw.recipient ? normalizeParty(raw.recipient) : null,
    issueDate: raw.issueDate ? dateOnly(raw.issueDate, 'issueDate') : '',
    saleDate: raw.saleDate ? dateOnly(raw.saleDate, 'saleDate') : '',
    currency: text(raw.currency, 3).toUpperCase() || 'PLN',
    items,
    totals,
    payment: normalizePayment(raw.payment || {}),
    references: stableClone(raw.references || {}),
    notes: text(raw.notes, 4000),
  };
}

function validateFinalizableInvoice(invoice = {}) {
  const blockers = [];
  if (!Object.values(INVOICE_TYPES).includes(invoice.type)) blockers.push('invoice_type_invalid');
  if (!invoice.source?.provider || !invoice.source?.entityType || !invoice.source?.entityId) blockers.push('invoice_source_incomplete');
  if (!invoice.seller?.name) blockers.push('seller_name_required');
  if (!invoice.issueDate) blockers.push('issue_date_required');
  if (!/^[A-Z]{3}$/.test(invoice.currency || '')) blockers.push('currency_invalid');
  if (!Array.isArray(invoice.items) || invoice.items.length === 0) blockers.push('invoice_items_required');

  for (const [index, item] of (invoice.items || []).entries()) {
    if (!item.name) blockers.push(`item_${index}_name_required`);
    if (!item.quantity) blockers.push(`item_${index}_quantity_required`);
    if (!item.unitPrice) blockers.push(`item_${index}_unit_price_required`);
    if (!item.priceBasis || item.priceBasis === PRICE_BASIS.UNKNOWN) blockers.push(`item_${index}_price_basis_required`);
    if (!item.vat?.code) blockers.push(`item_${index}_vat_code_required`);
    if (!item.amounts?.net || !item.amounts?.vat || !item.amounts?.gross) {
      blockers.push(`item_${index}_amounts_required`);
    } else if (!moneyEquals(addMoney([item.amounts.net, item.amounts.vat]), item.amounts.gross)) {
      blockers.push(`item_${index}_amounts_inconsistent`);
    }
  }

  const totals = invoice.totals || {};
  if (!totals.net || !totals.vat || !totals.gross) {
    blockers.push('invoice_totals_required');
  } else if (!moneyEquals(addMoney([totals.net, totals.vat]), totals.gross)) {
    blockers.push('invoice_totals_inconsistent');
  }

  if ((invoice.items || []).length && !blockers.some((code) => /_amounts_(?:required|inconsistent)$/.test(code))) {
    const derived = deriveTotals(invoice.items);
    if (!moneyEquals(derived.net, totals.net) || !moneyEquals(derived.vat, totals.vat) || !moneyEquals(derived.gross, totals.gross)) {
      blockers.push('invoice_totals_do_not_match_items');
    }
  }

  return [...new Set(blockers)];
}

function buildSnapshotPayload(invoice = {}) {
  const normalized = normalizeInvoiceDraft(invoice);
  return stableClone(normalized);
}

module.exports = {
  INVOICE_CORE_VERSION,
  INVOICE_TYPES,
  INVOICE_STATUSES,
  PRICE_BASIS,
  normalizeActor,
  normalizeInvoiceDraft,
  normalizeParty,
  validateFinalizableInvoice,
  buildSnapshotPayload,
};
