'use strict';

function clean(value) { return String(value ?? '').trim(); }

function orderKey(accountId, orderId) {
  const a = clean(accountId);
  const o = clean(orderId);
  return a && o ? `${a}:${o}` : '';
}

function sourceKey(accountId, sourceType, sourceId) {
  const a = clean(accountId);
  const t = clean(sourceType).toLowerCase();
  const i = clean(sourceId);
  return a && t && i ? `${a}:${t}:${i}` : '';
}

function productKey(accountId, product = {}) {
  const a = clean(accountId || product?.baseLinkerAccountId);
  const storage = clean(product?.storage).toLowerCase();
  const storageId = clean(product?.storage_id ?? product?.storageId);
  const productId = clean(product?.product_id ?? product?.productId);
  return a && storage && productId ? `${a}:${storage}:${storageId}:${productId}` : '';
}

function resolveSourceName(sources, sourceType, sourceId) {
  const type = clean(sourceType).toLowerCase();
  const id = clean(sourceId);
  if (!type || !id || !sources || typeof sources !== 'object') return '';
  const bucket = sources[type];
  if (!bucket || typeof bucket !== 'object') return '';
  const exact = bucket[id] ?? bucket[String(id)];
  if (exact !== undefined && exact !== null) return clean(exact);
  // BaseLinker documents order_return as a generic source entry under key 0
  // while concrete orders can carry the specific return id. This documented
  // display rule never changes identity: accountId + order_return + exact id.
  if (type === 'order_return') return clean(bucket[0] ?? bucket['0']);
  return '';
}

function annotateOrder(order, account, sources = null) {
  if (!order || typeof order !== 'object') return order;
  const accountId = clean(account?.accountId || account?.baseLinkerAccountId);
  const accountName = clean(account?.name || account?.accountName || account?.baseLinkerAccountName);
  const sourceType = clean(order.order_source);
  const sourceId = clean(order.order_source_id);
  return {
    ...order,
    baseLinkerAccountId: accountId,
    baseLinkerAccountName: accountName,
    baseLinkerAccountColor: clean(account?.color),
    sourceName: resolveSourceName(sources || account?.metadataSnapshot?.sources, sourceType, sourceId),
    orderKey: orderKey(accountId, order.order_id),
  };
}

module.exports = { orderKey, sourceKey, productKey, resolveSourceName, annotateOrder };
