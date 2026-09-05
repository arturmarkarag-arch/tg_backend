const { callBaseLinker } = require('./baseLinkerClient');
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
  dateConfirmedFrom,
  statusId,
  orderId,
  includeUnconfirmed = false,
} = {}) {
  const params = {
    ...BASE_INCLUDE_FLAGS,
    get_unconfirmed_orders: Boolean(includeUnconfirmed),
  };

  const confirmedFrom = toOptionalPositiveInt(dateConfirmedFrom);
  if (confirmedFrom !== null) {
    // Unconfirmed orders do not have a usable date_confirmed. For that opt-in
    // view the same UI period is applied to creation time instead.
    if (params.get_unconfirmed_orders) params.date_from = confirmedFrom;
    else params.date_confirmed_from = confirmedFrom;
  }

  const status = toOptionalPositiveInt(statusId);
  if (status !== null) params.status_id = status;

  const order = toOptionalPositiveInt(orderId);
  if (order !== null) params.order_id = order;

  return params;
}

/**
 * Reads all BaseLinker pages in the requested confirmation-date window.
 * BaseLinker returns max 100 orders and explicitly documents advancing
 * date_confirmed_from to last date_confirmed + 1 second.
 *
 * No BaseLinker order is written into our warehouse Order collection. This
 * service is a read adapter; local picking state will get its own model later.
 */
async function fetchBaseLinkerOrders(options = {}, callApi = callBaseLinker) {
  const requestedMaxPages = Number(options.maxPages);
  const maxPages = Number.isInteger(requestedMaxPages)
    ? Math.min(90, Math.max(1, requestedMaxPages))
    : 20;

  const baseParams = buildOrdersParameters(options);

  // Exact order lookup is one request; cursor pagination is irrelevant.
  if (baseParams.order_id !== undefined) {
    const payload = await callApi('getOrders', baseParams);
    return {
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      pageCount: 1,
      truncated: false,
      nextDateConfirmedFrom: null,
    };
  }

  const unconfirmedMode = baseParams.get_unconfirmed_orders === true;
  let cursor = unconfirmedMode ? null : (baseParams.date_confirmed_from ?? null);
  const byId = new Map();
  let pageCount = 0;
  let truncated = false;
  let nextDateConfirmedFrom = null;
  let nextIdFrom = null;

  for (; pageCount < maxPages; pageCount += 1) {
    const params = { ...baseParams };
    if (unconfirmedMode) {
      if (cursor !== null) params.id_from = cursor;
    } else if (cursor !== null) {
      params.date_confirmed_from = cursor;
    }

    const payload = await callApi('getOrders', params);
    const batch = Array.isArray(payload.orders) ? payload.orders : [];

    for (const order of batch) {
      if (order?.order_id !== undefined && order?.order_id !== null) {
        byId.set(String(order.order_id), order);
      }
    }

    if (batch.length < 100) {
      nextDateConfirmedFrom = null;
      break;
    }

    if (unconfirmedMode) {
      const lastOrderId = Number(batch[batch.length - 1]?.order_id || 0);
      if (!Number.isInteger(lastOrderId) || lastOrderId <= 0) throw appError('baselinker_cursor_invalid');
      const advanced = lastOrderId + 1;
      if (cursor !== null && advanced <= cursor) throw appError('baselinker_cursor_invalid');
      cursor = advanced;
      nextIdFrom = cursor;
    } else {
      const lastConfirmed = Number(batch[batch.length - 1]?.date_confirmed || 0);
      if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) {
        // We cannot safely advance BaseLinker's documented confirmation cursor.
        // Stop instead of potentially hammering the same page forever.
        throw appError('baselinker_cursor_invalid');
      }

      const advanced = Math.floor(lastConfirmed) + 1;
      if (cursor !== null && advanced <= cursor) throw appError('baselinker_cursor_invalid');
      cursor = advanced;
      nextDateConfirmedFrom = cursor;
    }
  }

  if (pageCount >= maxPages && (nextDateConfirmedFrom !== null || nextIdFrom !== null)) truncated = true;

  // Operational UI wants newest first; BaseLinker's scan cursor runs forward.
  const orders = Array.from(byId.values()).sort((a, b) => {
    const aDate = Number(a?.date_confirmed || a?.date_add || 0);
    const bDate = Number(b?.date_confirmed || b?.date_add || 0);
    if (bDate !== aDate) return bDate - aDate;
    return Number(b?.order_id || 0) - Number(a?.order_id || 0);
  });

  return { orders, pageCount: Math.min(pageCount + (truncated ? 0 : 1), maxPages), truncated, nextDateConfirmedFrom, nextIdFrom };
}

let metaCache = null;
let metaCacheExpiresAt = 0;
let metaInFlight = null;

async function fetchBaseLinkerOrderMeta(callApi = callBaseLinker) {
  const now = Date.now();
  if (callApi === callBaseLinker && metaCache && now < metaCacheExpiresAt) return metaCache;
  if (callApi === callBaseLinker && metaInFlight) return metaInFlight;

  const load = async () => {
    const [statusesPayload, sourcesPayload] = await Promise.all([
      callApi('getOrderStatusList', {}),
      callApi('getOrderSources', {}),
    ]);

    const result = {
      statuses: Array.isArray(statusesPayload.statuses) ? statusesPayload.statuses : [],
      sources: sourcesPayload.sources && typeof sourcesPayload.sources === 'object'
        ? sourcesPayload.sources
        : {},
    };

    if (callApi === callBaseLinker) {
      metaCache = result;
      metaCacheExpiresAt = Date.now() + (5 * 60 * 1000);
    }
    return result;
  };

  if (callApi !== callBaseLinker) return load();
  metaInFlight = load();
  try {
    return await metaInFlight;
  } finally {
    metaInFlight = null;
  }
}

module.exports = {
  BASE_INCLUDE_FLAGS,
  buildOrdersParameters,
  fetchBaseLinkerOrders,
  fetchBaseLinkerOrderMeta,
};
