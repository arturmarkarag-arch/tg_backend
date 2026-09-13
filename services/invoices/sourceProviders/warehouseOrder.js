'use strict';

const { appError } = require('../../../utils/errors');
const { createInvoiceSourceAdapter } = require('./contract');

const QUANTITY_MODES = Object.freeze({ ORDERED: 'ordered', FULFILLED: 'fulfilled' });

function quantityForItem(item, mode) {
  if (mode === QUANTITY_MODES.ORDERED) return Number(item.quantity || 0);
  if (item.cancelled || item.skipped || item.voided) return 0;
  if (item.packedQuantity != null) return Number(item.packedQuantity || 0);
  if (item.packed) return Number(item.quantity || 0);
  return 0;
}

function pricingForItem(item, input = {}) {
  const productId = String(item.productId || '');
  const override = input.pricingByProductId?.[productId] || {};
  return {
    unitPrice: override.unitPrice ?? item.price ?? '',
    priceBasis: override.priceBasis || input.priceBasis || 'unknown',
    vat: override.vat || input.defaultVat || {},
    amounts: override.amounts || {},
  };
}

function buildWarehouseOrderDraftFromDocument(order, input = {}) {
  const mode = String(input.quantityMode || '').trim().toLowerCase();
  if (!Object.values(QUANTITY_MODES).includes(mode)) throw appError('invoice_source_quantity_mode_required');

  const raw = typeof order?.toObject === 'function' ? order.toObject() : order;
  if (!raw?._id) throw appError('order_not_found');

  const items = (raw.items || []).map((item) => {
    const quantity = quantityForItem(item, mode);
    if (!(quantity > 0)) return null;
    const pricing = pricingForItem(item, input);
    return {
      sourceLineId: String(item._id || item.productId || ''),
      productRef: String(item.productId || ''),
      name: item.name || '',
      quantity,
      unit: input.unit || 'szt.',
      unitPrice: pricing.unitPrice,
      priceBasis: pricing.priceBasis,
      vat: pricing.vat,
      amounts: pricing.amounts,
      metadata: {
        orderItemId: item._id ? String(item._id) : '',
        quantityMode: mode,
      },
    };
  }).filter(Boolean);

  const buyerSnapshot = raw.buyerSnapshot || {};
  return {
    type: input.type || 'invoice',
    source: {
      provider: 'warehouse_order',
      entityType: 'order',
      entityId: String(raw._id),
      externalNumber: raw.orderNumber != null ? String(raw.orderNumber) : '',
      metadata: {
        orderingSessionId: raw.orderingSessionId || '',
        orderStatus: raw.status || '',
        orderType: raw.orderType || '',
        buyerTelegramId: raw.buyerTelegramId || '',
        quantityMode: mode,
      },
    },
    seller: input.seller || {},
    buyer: input.buyer || {
      name: buyerSnapshot.shopName || '',
      address: {
        street: buyerSnapshot.shopAddress || '',
        city: buyerSnapshot.shopCity || '',
      },
    },
    recipient: input.recipient || null,
    issueDate: input.issueDate || '',
    saleDate: input.saleDate || '',
    currency: input.currency || 'PLN',
    items,
    totals: input.totals || {},
    payment: input.payment || {},
    references: input.references || {},
    notes: input.notes || '',
  };
}

const adapter = createInvoiceSourceAdapter({
  id: 'warehouse_order',
  name: 'Warehouse order',
  entityTypes: ['order'],
  description: 'Builds an invoice draft from the warehouse Order domain without guessing VAT or whether source prices are net/gross.',
  metadata: { quantityModes: Object.values(QUANTITY_MODES) },
  buildDraft: async ({ sourceRef = {}, input = {}, context = {} } = {}) => {
    const orderId = String(sourceRef.entityId || sourceRef.id || '').trim();
    if (!orderId) throw appError('invoice_source_entity_id_required');
    const OrderModel = context.OrderModel || require('../../../models/Order');
    const order = context.orderDocument || await OrderModel.findById(orderId).lean();
    if (!order) throw appError('order_not_found');
    return buildWarehouseOrderDraftFromDocument(order, input);
  },
});

module.exports = Object.freeze({
  ...adapter,
  QUANTITY_MODES,
  buildWarehouseOrderDraftFromDocument,
});
