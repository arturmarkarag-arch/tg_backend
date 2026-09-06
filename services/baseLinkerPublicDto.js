'use strict';

function setIfDefined(target, key, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value === '') return;
  target[key] = value;
}

function compactOrderProduct(product = {}) {
  const out = {};
  // These fields are the complete contract needed by the worker UI today:
  // identity/grouping for picking, product lookup for the photo and qty/name.
  setIfDefined(out, 'storage', product.storage);
  setIfDefined(out, 'storage_id', product.storage_id);
  setIfDefined(out, 'order_product_id', product.order_product_id);
  setIfDefined(out, 'product_id', product.product_id);
  setIfDefined(out, 'variant_id', product.variant_id);
  setIfDefined(out, 'name', product.name);
  setIfDefined(out, 'attributes', product.attributes);
  setIfDefined(out, 'sku', product.sku);
  setIfDefined(out, 'ean', product.ean);
  setIfDefined(out, 'auction_id', product.auction_id);
  out.quantity = Number(product.quantity || 0);
  return out;
}

function compactOrder(order = {}) {
  const out = {};
  setIfDefined(out, 'order_id', order.order_id);
  setIfDefined(out, 'shop_order_id', order.shop_order_id);
  setIfDefined(out, 'external_order_id', order.external_order_id);
  setIfDefined(out, 'order_source', order.order_source);
  setIfDefined(out, 'order_source_id', order.order_source_id);
  setIfDefined(out, 'order_status_id', order.order_status_id);
  if (order.confirmed !== undefined && order.confirmed !== null) out.confirmed = Boolean(order.confirmed);
  setIfDefined(out, 'date_confirmed', order.date_confirmed);
  setIfDefined(out, 'date_in_status', order.date_in_status);
  setIfDefined(out, 'date_add', order.date_add);
  // getOrders already exposes a lightweight shipment hint. Keep it in the
  // worker payload so the client does not render a misleading TTN action (or
  // create one getOrderPackages request per visible card) when no shipment
  // number has been assigned yet.
  setIfDefined(out, 'delivery_package_module', order.delivery_package_module);
  setIfDefined(out, 'delivery_package_nr', order.delivery_package_nr);
  out.products = (Array.isArray(order.products) ? order.products : []).map(compactOrderProduct);
  return out;
}

function compactOrders(orders) {
  return (Array.isArray(orders) ? orders : []).filter(Boolean).map(compactOrder);
}

function firstImage(entry) {
  const images = Array.isArray(entry?.images) ? entry.images : [];
  return images.find((value) => typeof value === 'string' && value.trim()) || '';
}

function compactProductCatalog(productCatalog) {
  const out = {};
  for (const [key, entry] of Object.entries(productCatalog && typeof productCatalog === 'object' ? productCatalog : {})) {
    const image = firstImage(entry);
    out[key] = {
      state: String(entry?.state || 'unresolved'),
      images: image ? [image] : [],
    };
  }
  return out;
}

module.exports = {
  compactOrderProduct,
  compactOrder,
  compactOrders,
  compactProductCatalog,
};
