'use strict';

const crypto = require('crypto');
const BaseLinkerOrderIndex = require('../../../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../../../models/BaseLinkerPickingOrder');
const { listBaseLinkerAccounts } = require('../../baseLinkerAccounts');
const {
  CAPABILITIES,
  IMPLEMENTATION,
  PROVIDER_TYPES,
  createProviderAdapter,
} = require('./contract');
const { text, dateOrNull, lineSnapshot } = require('./reservationProjection');


function bool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function invoiceOrderRevision(order = {}) {
  const products = (Array.isArray(order.products) ? order.products : []).map((item) => ({
    id: String(item?.order_product_id || item?.transaction2_id || item?.transaction_id || ''),
    name: String(item?.name || ''),
    quantity: Number(item?.quantity || 0),
    gross: String(item?.price_brutto ?? ''),
    vat: String(item?.tax_rate ?? ''),
  }));
  const facts = {
    confirmed: bool(order.confirmed),
    invoiceRequested: bool(order.want_invoice),
    buyer: {
      company: String(order.invoice_company || ''), fullname: String(order.invoice_fullname || ''),
      nip: String(order.invoice_nip || ''), address: String(order.invoice_address || ''),
      postcode: String(order.invoice_postcode || ''), city: String(order.invoice_city || ''),
      country: String(order.invoice_country_code || ''), email: String(order.email || ''), phone: String(order.phone || ''),
    },
    currency: String(order.currency || ''),
    delivery: { method: String(order.delivery_method || ''), gross: String(order.delivery_price ?? '') },
    products,
    discounts: Array.isArray(order.discounts) ? order.discounts : [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex');
}

function invoiceSourceFromOrder({ accountId = '', order = {} } = {}) {
  const orderId = String(order?.order_id || '').trim();
  return {
    requested: bool(order?.want_invoice),
    revision: invoiceOrderRevision(order),
    sourceRef: { accountId: String(accountId || '').trim(), orderId },
    context: { orderDocument: order },
  };
}

function publicBaseLinkerAccount(account = {}) {
  const enabled = account.enabled === true;
  return {
    accountId: String(account.accountId || ''),
    name: String(account.name || ''),
    enabled,
    queueConfigured: account.queueConfigured === true,
    publicationReady: false,
    publicationState: 'unsupported',
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt || null,
    lastSyncError: String(account.lastSyncError || ''),
    lastConnectionCheckAt: account.lastConnectionCheckAt || null,
    lastConnectionError: String(account.lastConnectionError || ''),
  };
}

function canonicalOrder({ accountId, orderId, sourceType, externalOrderId }) {
  const type = text(sourceType, 80).toLowerCase();
  const external = text(externalOrderId, 180);
  if (type === 'allegro' && external) {
    return {
      canonicalProvider: 'allegro',
      canonicalOrderId: external,
      canonicalOrderKey: `allegro:${external}`,
      sourcePriority: 70,
      preferListingIdentity: true,
      matchByListingExternalId: true,
    };
  }
  const oid = text(orderId, 180);
  const aid = text(accountId, 100);
  return {
    canonicalProvider: 'baselinker',
    canonicalOrderId: oid,
    canonicalOrderKey: `baselinker:${aid}:${oid}`,
    sourcePriority: 80,
    preferListingIdentity: false,
    matchByListingExternalId: false,
  };
}

function snapshotsFromIndex(row) {
  const preview = row?.preview || {};
  const accountId = text(row?.baseLinkerAccountId, 100);
  const orderId = text(row?.orderId || preview?.order_id, 180);
  if (!accountId || !orderId) return [];
  const sourceType = text(preview?.order_source || row?.sourceType, 80).toLowerCase();
  const sourceExternalOrderId = text(preview?.external_order_id, 180);
  const canonical = canonicalOrder({ accountId, orderId, sourceType, externalOrderId: sourceExternalOrderId });
  const base = {
    canonicalProvider: canonical.canonicalProvider,
    canonicalOrderId: canonical.canonicalOrderId,
    canonicalOrderKey: canonical.canonicalOrderKey,
    sourcePriority: canonical.sourcePriority,
    sourceProvider: 'baselinker',
    sourceAccountId: accountId,
    sourceOrderId: orderId,
    sourceType,
    sourceExternalOrderId,
  };
  const observedAt = dateOrNull(row?.seenAt || row?.updatedAt) || new Date();
  return (Array.isArray(preview?.products) ? preview.products : [])
    .map((item) => lineSnapshot(base, item, 'reserved', observedAt, canonical))
    .filter(Boolean);
}

function snapshotsFromSent(row) {
  const accountId = text(row?.baseLinkerAccountId, 100);
  const orderId = text(row?.orderId, 180);
  if (!accountId || !orderId) return [];
  const sourceType = text(row?.sourceType, 80).toLowerCase();
  const sourceExternalOrderId = text(row?.sourceExternalOrderId, 180);
  const canonical = canonicalOrder({ accountId, orderId, sourceType, externalOrderId: sourceExternalOrderId });
  const base = {
    canonicalProvider: canonical.canonicalProvider,
    canonicalOrderId: canonical.canonicalOrderId,
    canonicalOrderKey: canonical.canonicalOrderKey,
    sourcePriority: canonical.sourcePriority,
    sourceProvider: 'baselinker',
    sourceAccountId: accountId,
    sourceOrderId: orderId,
    sourceType,
    sourceExternalOrderId,
  };
  const observedAt = dateOrNull(row?.sentAt || row?.updatedAt) || new Date();
  return (Array.isArray(row?.items) ? row.items : [])
    .map((item) => lineSnapshot(base, item, 'consumed', observedAt, canonical))
    .filter(Boolean);
}

async function loadDesiredSnapshots({ startedAt }) {
  const [activeRows, recentSent] = await Promise.all([
    BaseLinkerOrderIndex.find({}).select('baseLinkerAccountId orderId sourceType seenAt preview updatedAt').lean(),
    BaseLinkerPickingOrder.find({
      $or: [{ workflowStage: 'sent' }, { status: 'sent' }, { upstreamDisposition: 'sent' }],
      sentAt: { $gte: startedAt },
    }).select('baseLinkerAccountId orderId sourceType sourceExternalOrderId sentAt items updatedAt').lean(),
  ]);
  return [
    ...activeRows.flatMap(snapshotsFromIndex),
    ...recentSent.flatMap(snapshotsFromSent),
  ];
}

async function loadSourceReservationStates(rows = []) {
  const keys = rows
    .map((row) => ({ accountId: text(row.sourceAccountId, 100), orderId: text(row.sourceOrderId, 180) }))
    .filter((row) => row.accountId && row.orderId);
  if (!keys.length) return new Map();
  const docs = await BaseLinkerPickingOrder.find({
    $or: keys.map((row) => ({ baseLinkerAccountId: row.accountId, orderId: row.orderId })),
  }).select('baseLinkerAccountId orderId workflowStage status upstreamDisposition').lean();
  return new Map(docs.map((row) => {
    const disposition = text(row?.upstreamDisposition, 40).toLowerCase();
    const workflow = text(row?.workflowStage, 40).toLowerCase();
    const status = text(row?.status, 40).toLowerCase();
    const normalized = disposition === 'cancelled'
      ? 'cancelled'
      : (disposition === 'sent' || workflow === 'sent' || status === 'sent' ? 'sent' : '');
    return [`${text(row.baseLinkerAccountId, 100)}:${text(row.orderId, 180)}`, normalized];
  }));
}

const integrationApi = [
  { id: 'orders.read', label: 'Замовлення', operation: 'getOrders', direction: 'read', implementation: 'live' },
  { id: 'orders.status.write', label: 'Статус замовлення', operation: 'setOrderStatus', direction: 'write', implementation: 'live', note: 'Використовується лише контрольований перехід у статус Відправлено.' },
  { id: 'metadata.statuses.read', label: 'Статуси', operation: 'getOrderStatusList', direction: 'read', implementation: 'live' },
  { id: 'metadata.sources.read', label: 'Джерела замовлень', operation: 'getOrderSources', direction: 'read', implementation: 'live' },
  { id: 'catalog.inventories.read', label: 'Inventories', operation: 'getInventories', direction: 'read', implementation: 'live' },
  { id: 'catalog.products.read', label: 'Дані та фото товарів', operation: 'getInventoryProductsData', direction: 'read', implementation: 'live' },
  { id: 'shipments.packages.read', label: 'Посилки / ТТН', operation: 'getOrderPackages', direction: 'read', implementation: 'live' },
  { id: 'shipments.labels.read', label: 'Етикетка перевізника', operation: 'getLabel', direction: 'read', implementation: 'live' },
  { id: 'inventory.reservations', label: 'Central reservation ledger', operation: 'provider reservation projection', direction: 'internal', implementation: 'live', note: 'BaseLinker adapter віддає нормалізовані order holds у provider-neutral CommerceStockReservation.' },
  { id: 'offers.publish', label: 'Публікація товарів', operation: 'catalog outbound', direction: 'write', implementation: 'planned' },
  { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'catalog outbound', direction: 'write', implementation: 'planned' },
  { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'catalog outbound', direction: 'write', implementation: 'planned' },
];

module.exports = createProviderAdapter({
  id: 'baselinker',
  name: 'BaseLinker',
  type: PROVIDER_TYPES.AGGREGATOR,
  implementation: IMPLEMENTATION.LIVE,
  description: 'Aggregator adapter для замовлень, shipment/picking read-models та Commerce reservation projection.',
  capabilities: {
    [CAPABILITIES.ACCOUNTS]: true,
    [CAPABILITIES.ORDERS_READ]: true,
    [CAPABILITIES.INVENTORY_RESERVATIONS]: true,
    [CAPABILITIES.INVOICE_SOURCE]: true,
  },
  listAccounts: ({ includeDisabled = true } = {}) => listBaseLinkerAccounts({ includeDisabled }),
  publicAccount: publicBaseLinkerAccount,
  integrationApi,
  invoiceSource: { adapterId: 'baselinker_order', fromOrder: invoiceSourceFromOrder },
  reservationProjection: {
    loadDesiredSnapshots,
    loadSourceReservationStates,
  },
  metadata: {
    orderWorkspace: true,
    productModel: 'aggregated_order',
  },
});
