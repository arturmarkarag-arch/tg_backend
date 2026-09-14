'use strict';

const { appError } = require('../../../utils/errors');
const { formatWarsawDateKey } = require('../../../utils/warsawDateTime');
const { makeBaseLinkerAccountCaller } = require('../../baseLinkerClient');
const { fetchBaseLinkerOrders } = require('../../baseLinkerOrders');
const { createInvoiceSourceAdapter } = require('./contract');
const {
  buildInvoiceDraftFromOrderSnapshot,
  normalizeOrderSourceSnapshot,
  snapshotHash,
} = require('./orderSourceContract');

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function unixDateKey(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  try { return formatWarsawDateKey(new Date(seconds * 1000)); } catch (_) { return ''; }
}

function billingBuyer(order = {}) {
  const wantsInvoice = bool(order.want_invoice);
  const company = wantsInvoice ? text(order.invoice_company, 300) : text(order.delivery_company, 300);
  const person = wantsInvoice ? text(order.invoice_fullname, 300) : text(order.delivery_fullname, 300);
  return {
    name: company || person,
    taxId: wantsInvoice ? text(order.invoice_nip, 80) : '',
    taxIdType: wantsInvoice && text(order.invoice_nip, 80) ? (text(order.invoice_country_code, 2).toUpperCase() === 'PL' ? 'nip' : 'tax_id') : '',
    email: text(order.email, 320),
    phone: text(order.phone, 80),
    address: {
      street: wantsInvoice ? text(order.invoice_address, 250) : text(order.delivery_address, 250),
      postalCode: wantsInvoice ? text(order.invoice_postcode, 30) : text(order.delivery_postcode, 30),
      city: wantsInvoice ? text(order.invoice_city, 120) : text(order.delivery_city, 120),
      countryCode: wantsInvoice ? text(order.invoice_country_code, 2).toUpperCase() : text(order.delivery_country_code, 2).toUpperCase(),
    },
  };
}

function expectedGross(order = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
  const productTotal = products.reduce((sum, item) => sum + (Number(item?.price_brutto) || 0) * (Number(item?.quantity) || 0), 0);
  return productTotal + (Number(order.delivery_price) || 0);
}

function snapshotFromBaseLinkerOrder(order = {}, { accountId = '' } = {}) {
  const orderId = text(order.order_id, 180);
  const currency = text(order.currency, 3).toUpperCase();
  const total = expectedGross(order);
  const paidAmount = Number(order.payment_done) || 0;
  const snapshot = {
    provider: 'baselinker',
    adapter: 'baselinker_order',
    accountId,
    orderId,
    externalNumber: text(order.external_order_id || order.shop_order_id || order.order_id, 180),
    revision: text(order.date_in_status || order.date_confirmed || order.date_add, 180),
    observedAt: new Date().toISOString(),
    confirmed: order.confirmed === true || order.confirmed === 1 || order.confirmed === '1',
    invoiceRequested: bool(order.want_invoice),
    currency,
    saleDate: unixDateKey(order.date_confirmed || order.date_add),
    buyer: billingBuyer(order),
    items: (Array.isArray(order.products) ? order.products : []).map((item) => ({
      sourceLineId: text(item?.order_product_id || item?.transaction2_id || item?.transaction_id, 160),
      productRef: text(item?.product_id || item?.auction_id || item?.sku || item?.ean, 160),
      name: text(item?.name, 500),
      quantity: item?.quantity,
      unit: 'szt.',
      unitPriceGross: item?.price_brutto,
      currency,
      vatRate: item?.tax_rate,
      metadata: {
        sku: text(item?.sku, 160),
        ean: text(item?.ean, 80),
        auctionId: text(item?.auction_id, 160),
      },
    })),
    delivery: {
      name: text(order.delivery_method, 300) || 'Dostawa',
      gross: order.delivery_price ?? '',
      currency,
      // getOrders exposes gross delivery price but no delivery VAT rate.
      // Never derive it from product lines silently.
      vat: {},
    },
    payment: {
      method: bool(order.payment_method_cod) ? 'cash_on_delivery' : text(order.payment_method, 80).toLowerCase(),
      paid: total > 0 ? paidAmount + 0.005 >= total : paidAmount > 0,
      paidAt: '',
    },
    discountsPresent: Array.isArray(order.discounts) && order.discounts.length > 0,
  };
  return normalizeOrderSourceSnapshot(snapshot);
}

async function fetchExact(accountId, orderId) {
  const caller = makeBaseLinkerAccountCaller(accountId, { usageStage: 'invoice_source_exact' });
  const result = await fetchBaseLinkerOrders({ orderId, includeUnconfirmed: false, includeDiscountsData: true, maxPages: 1 }, caller);
  const order = (result.orders || []).find((row) => String(row?.order_id || '') === String(orderId)) || null;
  if (!order) throw appError('baselinker_order_not_returned', { orderId: String(orderId), upstreamMethod: 'getOrders' });
  return order;
}

const adapter = createInvoiceSourceAdapter({
  id: 'baselinker_order',
  name: 'BaseLinker order',
  entityTypes: ['order'],
  description: 'Exact-reads one confirmed BaseLinker order. Full PII/billing payload remains request-local and is not written to the worker order index.',
  metadata: { sourceAuthority: 'upstream_order', upstreamProvider: 'baselinker', exactRead: true, piiPersistedOutsideInvoice: false },
  buildDraft: async ({ sourceRef = {}, input = {}, context = {} } = {}) => {
    const accountId = text(sourceRef.accountId, 96);
    const orderId = text(sourceRef.orderId || sourceRef.entityId || sourceRef.id, 180);
    if (!accountId) throw appError('invoice_source_account_id_required');
    if (!orderId) throw appError('invoice_source_entity_id_required');
    const order = context.orderDocument || await fetchExact(accountId, orderId);
    const snapshot = snapshotFromBaseLinkerOrder(order, { accountId });
    return buildInvoiceDraftFromOrderSnapshot(snapshot, input);
  },
  verifySource: async ({ invoice, context = {} } = {}) => {
    const accountId = text(invoice?.source?.metadata?.accountId, 96);
    const orderId = text(invoice?.source?.metadata?.orderId || invoice?.source?.entityId, 180);
    if (!accountId || !orderId) throw appError('invoice_source_contract_invalid', { blockers: ['invoice_source_identity_incomplete'] });
    const order = context.orderDocument || await fetchExact(accountId, orderId);
    const snapshot = snapshotFromBaseLinkerOrder(order, { accountId });
    return {
      currentSha256: snapshotHash(snapshot),
      expectedSha256: text(invoice?.source?.metadata?.snapshotSha256, 128),
      snapshot,
    };
  },
});

module.exports = Object.freeze({ ...adapter, snapshotFromBaseLinkerOrder });
