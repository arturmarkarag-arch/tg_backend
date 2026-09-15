'use strict';

const { appError } = require('../../../utils/errors');
const { formatWarsawDateKey } = require('../../../utils/warsawDateTime');
const { allegroRequest } = require('../../allegroHttpClient');
const { createInvoiceSourceAdapter } = require('./contract');
const {
  buildInvoiceDraftFromOrderSnapshot,
  normalizeOrderSourceSnapshot,
  snapshotHash,
} = require('./orderSourceContract');

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function joinedName(...values) {
  return values.map((value) => text(value, 160)).filter(Boolean).join(' ').trim();
}

function dateKey(value) {
  if (!value) return '';
  try { return formatWarsawDateKey(value); } catch (_) { return ''; }
}

function invoiceAddress(order = {}) {
  const invoice = order.invoice || {};
  const billing = invoice.address || {};
  if (invoice.required === true) return billing;
  return order.delivery?.address || billing || order.buyer?.address || {};
}

function buyerFromOrder(order = {}) {
  const invoice = order.invoice || {};
  const address = invoiceAddress(order);
  const company = address.company || {};
  const natural = address.naturalPerson || {};
  const buyer = order.buyer || {};
  const name = text(company.name, 300)
    || joinedName(natural.firstName, natural.lastName)
    || text(address.companyName, 300)
    || joinedName(address.firstName, address.lastName)
    || text(buyer.companyName, 300)
    || joinedName(buyer.firstName, buyer.lastName);
  const taxId = text(company.taxId || invoice.payer?.taxId || invoice.payer?.company?.taxId, 80);
  return {
    name,
    taxId,
    taxIdType: taxId && text(address.countryCode, 2).toUpperCase() === 'PL' ? 'nip' : (taxId ? 'tax_id' : ''),
    email: text(buyer.email, 320),
    phone: text(address.phoneNumber || buyer.phoneNumber, 80),
    address: {
      street: text(address.street, 250),
      postalCode: text(address.zipCode || address.postCode, 30),
      city: text(address.city, 120),
      countryCode: text(address.countryCode, 2).toUpperCase(),
    },
  };
}

function saleDateFromOrder(order = {}) {
  const bought = (Array.isArray(order.lineItems) ? order.lineItems : [])
    .map((item) => item?.boughtAt)
    .filter(Boolean)
    .sort()[0];
  return dateKey(bought || order.payment?.finishedAt || order.updatedAt);
}

function snapshotFromAllegroOrder(order = {}, { accountId = '' } = {}) {
  const orderId = text(order.id, 128);
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const status = text(order.status, 80).toUpperCase();
  const currency = text(lineItems[0]?.price?.currency || order.delivery?.cost?.currency, 3).toUpperCase();
  const snapshot = {
    provider: 'allegro',
    adapter: 'allegro_order',
    accountId,
    orderId,
    canonicalProvider: 'allegro',
    canonicalOrderId: orderId,
    externalNumber: orderId,
    revision: text(order.revision, 180),
    observedAt: new Date().toISOString(),
    confirmed: status === 'READY_FOR_PROCESSING',
    invoiceRequested: order.invoice?.required === true,
    currency,
    saleDate: saleDateFromOrder(order),
    buyer: buyerFromOrder(order),
    items: lineItems.map((item) => ({
      sourceLineId: text(item?.id, 160),
      productRef: text(item?.offer?.id || item?.offer?.external?.id, 160),
      name: text(item?.offer?.name, 500),
      quantity: item?.quantity,
      unit: 'szt.',
      unitPriceGross: item?.price?.amount,
      currency: text(item?.price?.currency, 3).toUpperCase(),
      vat: { rate: item?.tax?.rate ?? '', code: item?.tax?.rate ?? '' },
      metadata: {
        offerId: text(item?.offer?.id, 160),
        offerExternalId: text(item?.offer?.external?.id, 300),
      },
    })),
    delivery: {
      name: text(order.delivery?.method?.name, 300) || 'Dostawa',
      gross: order.delivery?.cost?.amount ?? '',
      currency: text(order.delivery?.cost?.currency, 3).toUpperCase(),
      // Allegro checkout-form does not provide a delivery VAT rate. Fail closed
      // for paid delivery instead of inventing one from product VAT.
      vat: {},
    },
    payment: {
      method: text(order.payment?.type || order.payment?.provider, 80).toLowerCase(),
      paid: Boolean(order.payment?.finishedAt),
      paidAt: text(order.payment?.finishedAt, 64),
    },
    discountsPresent: lineItems.some((item) => Array.isArray(item?.discounts) && item.discounts.length > 0)
      || (Array.isArray(order.discounts) && order.discounts.length > 0),
  };
  return normalizeOrderSourceSnapshot(snapshot);
}

async function fetchExact(accountId, orderId) {
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/order/checkout-forms/${encodeURIComponent(orderId)}`,
    stage: 'invoice_source_exact',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  const order = result.payload || {};
  if (text(order.id, 128) !== orderId || !Array.isArray(order.lineItems)) throw appError('allegro_order_response_invalid');
  return order;
}

const adapter = createInvoiceSourceAdapter({
  id: 'allegro_order',
  name: 'Allegro order',
  entityTypes: ['order'],
  description: 'Exact-reads one Allegro checkout form and maps only provider-authoritative billing, price and VAT data into Invoice Core.',
  metadata: { sourceAuthority: 'upstream_order', upstreamProvider: 'allegro', exactRead: true, piiPersistedOutsideInvoice: false },
  buildDraft: async ({ sourceRef = {}, input = {}, context = {} } = {}) => {
    const accountId = text(sourceRef.accountId, 64);
    const orderId = text(sourceRef.orderId || sourceRef.entityId || sourceRef.id, 128);
    if (!accountId) throw appError('invoice_source_account_id_required');
    if (!orderId) throw appError('invoice_source_entity_id_required');
    const order = context.orderDocument || await fetchExact(accountId, orderId);
    const snapshot = snapshotFromAllegroOrder(order, { accountId });
    return buildInvoiceDraftFromOrderSnapshot(snapshot, input);
  },
  verifySource: async ({ invoice, context = {} } = {}) => {
    const accountId = text(invoice?.source?.metadata?.accountId, 64);
    const orderId = text(invoice?.source?.metadata?.orderId || invoice?.source?.entityId, 128);
    if (!accountId || !orderId) throw appError('invoice_source_contract_invalid', { blockers: ['invoice_source_identity_incomplete'] });
    const order = context.orderDocument || await fetchExact(accountId, orderId);
    const snapshot = snapshotFromAllegroOrder(order, { accountId });
    return {
      currentSha256: snapshotHash(snapshot),
      expectedSha256: text(invoice?.source?.metadata?.snapshotSha256, 128),
      snapshot,
    };
  },
});

module.exports = Object.freeze({ ...adapter, snapshotFromAllegroOrder });
