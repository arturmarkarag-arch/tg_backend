const { appError } = require('../utils/errors');

// Worker fulfilment does not need commissions, connect payloads, discounts or
// arbitrary extra fields. BaseLinker defaults those optional expansions to off,
// so do not request bytes that we would discard immediately.
const BASE_INCLUDE_FLAGS = Object.freeze({});

function toOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function buildOrdersParameters({
  statusId,
  orderId,
  idFrom,
  includeUnconfirmed = false,
} = {}) {
  const params = {
    ...BASE_INCLUDE_FLAGS,
    get_unconfirmed_orders: Boolean(includeUnconfirmed),
  };

  const status = toOptionalPositiveInt(statusId);
  if (status !== null) params.status_id = status;

  const order = toOptionalPositiveInt(orderId);
  if (order !== null) params.order_id = order;

  const fromId = toOptionalPositiveInt(idFrom);
  if (fromId !== null && order === null) params.id_from = fromId;

  return params;
}

/**
 * Reads BaseLinker only by our current warehouse contract:
 * - exact order_id for one concrete order, or
 * - status_id + id_from for a queue scan.
 *
 * There is deliberately no date/period mode. Queue membership is defined by
 * BaseLinker statuses, while Sent/Cancelled 14-day history is decided from each
 * returned order's date_in_status. Full BaseLinker orders remain request-local
 * and are never persisted as a warehouse mirror.
 */
async function fetchBaseLinkerOrders(options = {}, callApi) {
  if (typeof callApi !== 'function') throw appError('baselinker_account_id_required');
  const requestedMaxPages = Number(options.maxPages);
  const maxPages = Number.isInteger(requestedMaxPages)
    ? Math.min(90, Math.max(1, requestedMaxPages))
    : 20;

  const baseParams = buildOrdersParameters(options);
  if (options.orderId !== undefined && (!Number.isSafeInteger(Number(options.orderId)) || Number(options.orderId) <= 0)) {
    throw appError('baselinker_order_id_invalid');
  }
  if (baseParams.order_id === undefined && !(baseParams.status_id > 0)) {
    throw appError('baselinker_queue_not_configured');
  }

  // Exact order lookup is one request; cursor pagination is irrelevant.
  if (baseParams.order_id !== undefined) {
    const payload = await callApi('getOrders', baseParams);
    return {
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      pageCount: 1,
      truncated: false,
      nextIdFrom: null,
    };
  }

  let cursor = baseParams.id_from ?? null;
  const byId = new Map();
  let pageCount = 0;
  let truncated = false;
  let nextIdFrom = null;

  for (; pageCount < maxPages; pageCount += 1) {
    const params = { ...baseParams };
    delete params.id_from;
    if (cursor !== null) params.id_from = cursor;

    const payload = await callApi('getOrders', params);
    const batch = Array.isArray(payload.orders) ? payload.orders : [];

    for (const order of batch) {
      if (order?.order_id !== undefined && order?.order_id !== null) {
        byId.set(String(order.order_id), order);
      }
    }

    if (batch.length < 100) {
      nextIdFrom = null;
      break;
    }

    const lastOrderId = Number(batch[batch.length - 1]?.order_id || 0);
    if (!Number.isSafeInteger(lastOrderId) || lastOrderId <= 0) throw appError('baselinker_cursor_invalid');
    const advanced = lastOrderId + 1;
    if (cursor !== null && advanced <= cursor) throw appError('baselinker_cursor_invalid');
    cursor = advanced;
    nextIdFrom = cursor;
  }

  if (pageCount >= maxPages && nextIdFrom !== null) truncated = true;

  // Operational UI wants newest first; id_from scans run forward.
  const orders = Array.from(byId.values()).sort((a, b) => {
    const aDate = Number(a?.date_confirmed || a?.date_add || 0);
    const bDate = Number(b?.date_confirmed || b?.date_add || 0);
    if (bDate !== aDate) return bDate - aDate;
    return Number(b?.order_id || 0) - Number(a?.order_id || 0);
  });

  return { orders, pageCount: Math.min(pageCount + (truncated ? 0 : 1), maxPages), truncated, nextIdFrom };
}

async function fetchBaseLinkerOrderMeta(callApi) {
  if (typeof callApi !== 'function') throw appError('baselinker_account_id_required');
  const [statusesPayload, sourcesPayload] = await Promise.all([
    callApi('getOrderStatusList', {}),
    callApi('getOrderSources', {}),
  ]);

  return {
    statuses: Array.isArray(statusesPayload.statuses) ? statusesPayload.statuses : [],
    sources: sourcesPayload.sources && typeof sourcesPayload.sources === 'object'
      ? sourcesPayload.sources
      : {},
  };
}

module.exports = {
  BASE_INCLUDE_FLAGS,
  buildOrdersParameters,
  fetchBaseLinkerOrders,
  fetchBaseLinkerOrderMeta,
};
