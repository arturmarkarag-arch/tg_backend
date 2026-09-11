'use strict';

const AllegroAccount = require('../models/AllegroAccount');
const AllegroOrderIndex = require('../models/AllegroOrderIndex');
const AllegroOrderSyncState = require('../models/AllegroOrderSyncState');
const { allegroRequest } = require('./allegroHttpClient');
const { getAllegroAccount, listAllegroAccounts } = require('./allegroAccounts');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');
const { withLock } = require('../utils/lock');

const EVENT_LIMIT = Math.min(1000, Math.max(10, Number(process.env.ALLEGRO_ORDER_EVENT_LIMIT) || 200));
const MAX_EVENT_PAGES_PER_TICK = Math.min(10, Math.max(1, Number(process.env.ALLEGRO_ORDER_EVENT_PAGES_PER_TICK) || 2));
const MAX_DETAIL_REFRESHES_PER_TICK = Math.min(500, Math.max(10, Number(process.env.ALLEGRO_ORDER_DETAIL_MAX_PER_TICK) || 100));
const BOOTSTRAP_PAGE_SIZE = 100;
const BOOTSTRAP_MAX_PAGES = Math.min(100, Math.max(1, Number(process.env.ALLEGRO_ORDER_BOOTSTRAP_MAX_PAGES) || 100));
// Allegro exposes order events for the last 60 days. Re-bootstrap before that
// boundary if this service has not successfully polled an account for a long
// outage; otherwise an old cursor may no longer be a safe recovery point.
const JOURNAL_OUTAGE_REBOOTSTRAP_MS = Math.min(59, Math.max(7, Number(process.env.ALLEGRO_ORDER_REBOOTSTRAP_AFTER_DAYS) || 55)) * 24 * 60 * 60 * 1000;
const ORDER_SYNC_LOCK_TTL_MS = Math.min(60 * 60_000, Math.max(5 * 60_000, Number(process.env.ALLEGRO_ORDER_SYNC_LOCK_TTL_MS) || 15 * 60_000));
const ORDER_SYNC_STALE_AFTER_MS = Math.min(24 * 60 * 60_000, Math.max(60_000, Number(process.env.ALLEGRO_ORDER_STALE_AFTER_MS) || 5 * 60_000));
const PAGE_SIZE_VALUES = new Set([10, 20]);
const ACTIVE_FULFILLMENT_STATUSES = Object.freeze([
  'NEW',
  'PROCESSING',
  'READY_FOR_SHIPMENT',
  'READY_FOR_PICKUP',
  'SUSPENDED',
]);
const EVENT_TYPES_REQUIRING_EXACT_REFRESH = new Set([
  'READY_FOR_PROCESSING',
  'BUYER_CANCELLED',
  'AUTO_CANCELLED',
  'FULFILLMENT_STATUS_CHANGED',
]);

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function unixSeconds(value) {
  const date = safeDate(value);
  return date ? Math.floor(date.getTime() / 1000) : 0;
}

function escapedRegex(value) {
  return clean(value, 300).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePage(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function normalizePageSize(value) {
  const n = Number(value);
  return PAGE_SIZE_VALUES.has(n) ? n : 10;
}

function checkoutFormIdFromEvent(event) {
  return clean(event?.order?.checkoutForm?.id, 128);
}

function workflowStageForCheckoutForm(order) {
  const orderStatus = clean(order?.status, 80).toUpperCase();
  const fulfillmentStatus = clean(order?.fulfillment?.status, 80).toUpperCase();
  if (orderStatus === 'CANCELLED' || ['CANCELLED', 'RETURNED'].includes(fulfillmentStatus)) return 'cancelled';
  if (['SENT', 'PICKED_UP'].includes(fulfillmentStatus)) return 'sent';
  if (fulfillmentStatus === 'SUSPENDED') return 'deferred';
  return 'processing';
}

function firstBoughtAt(order) {
  const timestamps = (Array.isArray(order?.lineItems) ? order.lineItems : [])
    .map((item) => safeDate(item?.boughtAt))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  return timestamps[0] || safeDate(order?.updatedAt) || null;
}

function compactLineItem(item = {}) {
  const offerId = clean(item?.offer?.id, 128);
  const externalId = clean(item?.offer?.external?.id, 300);
  const product = {
    order_product_id: clean(item?.id, 128),
    product_id: '',
    variant_id: '',
    auction_id: offerId,
    name: clean(item?.offer?.name, 1000),
    sku: externalId,
    ean: '',
    quantity: Math.max(0, numberOrZero(item?.quantity)),
  };
  const priceAmount = clean(item?.price?.amount, 64);
  const priceCurrency = clean(item?.price?.currency, 16);
  if (priceAmount) product.price = { amount: priceAmount, currency: priceCurrency };
  return product;
}

function compactCheckoutForm(order, account) {
  const id = clean(order?.id, 128);
  const boughtAt = firstBoughtAt(order);
  const updatedAt = safeDate(order?.updatedAt);
  const fulfillmentProviderId = clean(order?.fulfillment?.provider?.id, 80).toUpperCase();
  const fulfillmentStatus = clean(order?.fulfillment?.status, 80).toUpperCase();
  const orderStatus = clean(order?.status, 80).toUpperCase();
  const upstreamStage = workflowStageForCheckoutForm(order);
  const shipmentSummary = clean(order?.fulfillment?.shipmentSummary?.lineItemsSent, 32).toUpperCase();
  const deliveryMethod = clean(order?.delivery?.method?.name || order?.delivery?.method?.id, 300);
  const marketplaceId = clean(order?.marketplace?.id, 80);
  const products = (Array.isArray(order?.lineItems) ? order.lineItems : []).map(compactLineItem);

  return {
    provider: 'allegro',
    allegroAccountId: clean(account?.accountId, 64),
    allegroAccountName: clean(account?.name, 160),
    allegroAccountColor: clean(account?.color, 32),
    order_id: id,
    external_order_id: id,
    revision: clean(order?.revision, 128),
    order_status: orderStatus,
    fulfillment_status: fulfillmentStatus,
    fulfillment_provider_id: fulfillmentProviderId,
    upstreamStage,
    marketplace_id: marketplaceId,
    date_add: unixSeconds(boughtAt),
    date_confirmed: unixSeconds(order?.payment?.finishedAt || boughtAt),
    updated_at: updatedAt ? updatedAt.toISOString() : '',
    delivery_method: deliveryMethod,
    shipment_summary: shipmentSummary,
    products,
  };
}

function operationalSearchText(preview) {
  const products = Array.isArray(preview?.products) ? preview.products : [];
  return [
    preview?.order_id,
    preview?.allegroAccountName,
    preview?.marketplace_id,
    preview?.order_status,
    preview?.fulfillment_status,
    preview?.delivery_method,
    ...products.flatMap((item) => [item?.order_product_id, item?.auction_id, item?.name, item?.sku, item?.ean]),
  ].filter(Boolean).join(' ').toLowerCase().slice(0, 8192);
}

function indexDocument(order, account, event = null) {
  const preview = compactCheckoutForm(order, account);
  return {
    accountId: clean(account?.accountId, 64),
    checkoutFormId: clean(order?.id, 128),
    revision: clean(order?.revision, 128),
    orderStatus: clean(order?.status, 80).toUpperCase(),
    fulfillmentStatus: clean(order?.fulfillment?.status, 80).toUpperCase(),
    fulfillmentProviderId: clean(order?.fulfillment?.provider?.id, 80).toUpperCase(),
    marketplaceId: clean(order?.marketplace?.id, 80),
    upstreamStage: preview.upstreamStage,
    orderSortDate: firstBoughtAt(order) || safeDate(order?.updatedAt),
    upstreamUpdatedAt: safeDate(order?.updatedAt),
    lastEventId: clean(event?.id, 128),
    lastEventType: clean(event?.type, 80),
    lastEventOccurredAt: safeDate(event?.occurredAt),
    preview,
    searchText: operationalSearchText(preview),
    seenAt: new Date(),
  };
}

async function upsertCheckoutForm(order, account, event = null) {
  const id = clean(order?.id, 128);
  if (!id) throw appError('allegro_order_response_invalid');
  const provider = clean(order?.fulfillment?.provider?.id, 80).toUpperCase();

  // One Fulfillment orders are fulfilled by Allegro warehouse and must never
  // enter our warehouse queue. If an existing order changes provider, block any
  // local picking state first and then remove the operational projection.
  if (provider !== 'SELLER') {
    await require('./allegroPicking').reconcileAllegroPickingFromUpstream({ accountId: account.accountId, order });
    const removed = await AllegroOrderIndex.deleteOne({ accountId: account.accountId, checkoutFormId: id });
    return { removed: removed.deletedCount > 0, checkoutFormId: id, order: null };
  }

  const doc = indexDocument(order, account, event);
  await AllegroOrderIndex.updateOne(
    { accountId: doc.accountId, checkoutFormId: doc.checkoutFormId },
    {
      $set: doc,
      // Stage 5 separates upstream fulfillment from our local warehouse shelf.
      // Upstream sync must never move a worker's deferred/processing order back
      // and forth just because fulfillment.status changed.
      $setOnInsert: {
        workflowStage: doc.upstreamStage === 'cancelled' ? 'cancelled' : doc.upstreamStage === 'sent' ? 'sent' : doc.upstreamStage === 'deferred' ? 'deferred' : 'processing',
        upstreamReviewRequired: false,
        warehouseStatus: '',
        sentBy: '',
        sentByName: '',
      },
    },
    { upsert: true },
  );
  await require('./allegroPicking').reconcileAllegroPickingFromUpstream({ accountId: account.accountId, order });
  const current = await AllegroOrderIndex.findOne({ accountId: doc.accountId, checkoutFormId: doc.checkoutFormId }).lean();
  return { removed: false, checkoutFormId: id, order: current ? publicOrderFromRow(current, account) : doc.preview };
}

async function fetchEventStats(accountId) {
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: '/order/event-stats',
    stage: 'order_event_stats',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  return {
    id: clean(result.payload?.latestEvent?.id, 128),
    occurredAt: safeDate(result.payload?.latestEvent?.occurredAt),
  };
}

async function fetchCheckoutForm(accountId, checkoutFormId) {
  return allegroRequest(accountId, {
    method: 'GET',
    path: `/order/checkout-forms/${encodeURIComponent(checkoutFormId)}`,
    stage: 'order_detail_refresh',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
}

async function fetchBootstrapActiveOrders(account) {
  const collected = [];
  let offset = 0;
  for (let page = 0; page < BOOTSTRAP_MAX_PAGES; page += 1) {
    const result = await allegroRequest(account.accountId, {
      method: 'GET',
      path: '/order/checkout-forms',
      query: {
        status: 'READY_FOR_PROCESSING',
        'fulfillment.provider.id': 'SELLER',
        // Allegro accepts the filter multiple times. urlFor() appends array
        // values, so one paginated snapshot covers all warehouse-active states.
        'fulfillment.status': ACTIVE_FULFILLMENT_STATUSES,
        sort: 'updatedAt',
        limit: BOOTSTRAP_PAGE_SIZE,
        offset,
      },
      stage: 'order_bootstrap',
      retryPolicy: 'safe',
      maxAttempts: 3,
    });
    const rows = Array.isArray(result.payload?.checkoutForms) ? result.payload.checkoutForms : [];
    collected.push(...rows);
    const totalCount = Math.max(rows.length, Number(result.payload?.totalCount) || 0);
    offset += rows.length;
    if (rows.length < BOOTSTRAP_PAGE_SIZE || offset >= totalCount) return collected;
    if (offset >= 10_000) throw appError('allegro_order_bootstrap_too_large');
  }
  throw appError('allegro_order_bootstrap_too_large');
}

async function bootstrapAccount(account, state) {
  const startedAt = new Date();
  await AllegroOrderSyncState.updateOne(
    { accountId: account.accountId },
    { $set: { bootstrapState: 'running', lastPollAt: startedAt, lastError: '' } },
    { upsert: true },
  );

  // Barrier FIRST: anything that happens after this event will be replayed by
  // the journal after the active-order snapshot is stored, preventing a race.
  const barrier = await fetchEventStats(account.accountId);
  const seen = new Map();
  const rows = await fetchBootstrapActiveOrders(account);
  for (const order of rows) {
    const id = clean(order?.id, 128);
    if (id) seen.set(id, order);
  }

  const upserted = [];
  for (const order of seen.values()) {
    const result = await upsertCheckoutForm(order, account, null);
    if (result.order) upserted.push(result.order);
  }

  // Any previously cached non-terminal row not present in the authoritative
  // active snapshot is no longer actionable. This matters for a safe re-bootstrap.
  const activeIds = [...seen.keys()];
  const staleQuery = {
    accountId: account.accountId,
    workflowStage: { $in: ['processing', 'deferred'] },
  };
  if (activeIds.length) staleQuery.checkoutFormId = { $nin: activeIds };
  const staleRows = await AllegroOrderIndex.find(staleQuery).select({ checkoutFormId: 1 }).lean();
  if (staleRows.length) {
    for (const row of staleRows) {
      await require('./allegroPicking').markAllegroPickingMissing({ accountId: account.accountId, orderId: row.checkoutFormId });
    }
    await AllegroOrderIndex.deleteMany(staleQuery);
  }

  const finishedAt = new Date();
  const updated = await AllegroOrderSyncState.findOneAndUpdate(
    { accountId: account.accountId },
    {
      $set: {
        initialized: true,
        bootstrapState: 'complete',
        cursorEventId: barrier.id,
        cursorOccurredAt: barrier.occurredAt,
        bootstrapBarrierEventId: barrier.id,
        bootstrapBarrierOccurredAt: barrier.occurredAt,
        lastBootstrapAt: finishedAt,
        lastSuccessfulPollAt: finishedAt,
        lastPollAt: finishedAt,
        lastEventCount: 0,
        lastOrderRefreshCount: upserted.length,
        consecutiveFailures: 0,
        nextRetryAt: null,
        lastError: '',
        lastErrorCode: '',
        lastErrorTraceId: '',
        lastErrorHttpStatus: null,
      },
    },
    { upsert: true, new: true },
  );
  await AllegroAccount.updateOne({ accountId: account.accountId }, {
    $set: { lastSuccessfulSyncAt: finishedAt, lastSyncError: '' },
  });

  emitOrdersChanged(account.accountId, {
    orders: upserted,
    removedOrderIds: staleRows.map((row) => clean(row.checkoutFormId, 128)).filter(Boolean),
    resync: true,
  });
  return { accountId: account.accountId, bootstrapped: true, orders: upserted.length, state: publicSyncState(updated) };
}

function relevantRefreshPrefix(events) {
  const prefix = [];
  const unique = new Set();
  for (const event of events) {
    const id = checkoutFormIdFromEvent(event);
    const type = clean(event?.type, 80).toUpperCase();
    if (id && EVENT_TYPES_REQUIRING_EXACT_REFRESH.has(type) && !unique.has(id)) {
      if (unique.size >= MAX_DETAIL_REFRESHES_PER_TICK) break;
      unique.add(id);
    }
    prefix.push(event);
  }
  return { prefix, checkoutFormIds: [...unique] };
}

async function mapLimit(values, limit, worker) {
  const items = Array.from(values || []);
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function eventByCheckoutForm(events) {
  const map = new Map();
  for (const event of events) {
    const id = checkoutFormIdFromEvent(event);
    const type = clean(event?.type, 80).toUpperCase();
    if (id && EVENT_TYPES_REQUIRING_EXACT_REFRESH.has(type)) map.set(id, event);
  }
  return map;
}

async function refreshCheckoutForms(account, ids, eventMap) {
  return mapLimit(ids, Math.min(4, MAX_DETAIL_REFRESHES_PER_TICK), async (id) => {
    try {
      const result = await fetchCheckoutForm(account.accountId, id);
      return upsertCheckoutForm(result.payload || {}, account, eventMap.get(id) || null);
    } catch (error) {
      // Merged purchases can make an old checkoutForm id disappear. Allegro
      // documents this as a normal 404 scenario; remove a stale local projection
      // and let the journal/new checkoutForm event become authoritative.
      if (Number(error?.status) === 404) {
        await require('./allegroPicking').markAllegroPickingMissing({ accountId: account.accountId, orderId: id });
        const removed = await AllegroOrderIndex.deleteOne({ accountId: account.accountId, checkoutFormId: id });
        return { checkoutFormId: id, removed: removed.deletedCount > 0, order: null, upstreamMissing: true };
      }
      throw error;
    }
  });
}

async function pollEventJournal(account, state) {
  let cursorEventId = clean(state?.cursorEventId, 128);
  let cursorOccurredAt = safeDate(state?.cursorOccurredAt);
  let totalEvents = 0;
  let totalRefreshed = 0;
  const changedOrders = new Map();
  const removedIds = new Set();
  let caughtUp = false;

  for (let page = 0; page < MAX_EVENT_PAGES_PER_TICK; page += 1) {
    const result = await allegroRequest(account.accountId, {
      method: 'GET',
      path: '/order/events',
      query: {
        ...(cursorEventId ? { from: cursorEventId } : {}),
        limit: EVENT_LIMIT,
      },
      stage: 'order_events',
      retryPolicy: 'safe',
      maxAttempts: 3,
    });
    let events = Array.isArray(result.payload?.events) ? result.payload.events : [];
    if (cursorEventId) events = events.filter((event) => clean(event?.id, 128) !== cursorEventId);
    if (!events.length) {
      caughtUp = true;
      break;
    }

    const { prefix, checkoutFormIds } = relevantRefreshPrefix(events);
    if (!prefix.length) break;
    const eventMap = eventByCheckoutForm(prefix);
    const refreshed = await refreshCheckoutForms(account, checkoutFormIds, eventMap);
    for (const item of refreshed) {
      if (item?.order) changedOrders.set(clean(item.checkoutFormId, 128), item.order);
      if (item?.removed) removedIds.add(clean(item.checkoutFormId, 128));
    }

    const last = prefix[prefix.length - 1];
    cursorEventId = clean(last?.id, 128) || cursorEventId;
    cursorOccurredAt = safeDate(last?.occurredAt) || cursorOccurredAt;
    totalEvents += prefix.length;
    totalRefreshed += checkoutFormIds.length;

    // We intentionally stopped before the end of the page because the exact
    // refresh budget was reached. Persist this prefix cursor and continue next tick.
    if (prefix.length < events.length) break;
    if (events.length < EVENT_LIMIT) {
      caughtUp = true;
      break;
    }
  }

  const now = new Date();
  const updated = await AllegroOrderSyncState.findOneAndUpdate(
    { accountId: account.accountId },
    {
      $set: {
        initialized: true,
        bootstrapState: 'complete',
        cursorEventId,
        cursorOccurredAt,
        lastPollAt: now,
        lastSuccessfulPollAt: now,
        lastEventCount: totalEvents,
        lastOrderRefreshCount: totalRefreshed,
        consecutiveFailures: 0,
        nextRetryAt: null,
        lastError: '',
        lastErrorCode: '',
        lastErrorTraceId: '',
        lastErrorHttpStatus: null,
      },
    },
    { upsert: true, new: true },
  );
  await AllegroAccount.updateOne({ accountId: account.accountId }, {
    $set: { lastSuccessfulSyncAt: now, lastSyncError: '' },
  });

  if (changedOrders.size || removedIds.size) {
    emitOrdersChanged(account.accountId, {
      orders: [...changedOrders.values()],
      removedOrderIds: [...removedIds].filter(Boolean),
      resync: false,
    });
  }
  return {
    accountId: account.accountId,
    bootstrapped: false,
    events: totalEvents,
    refreshedOrders: totalRefreshed,
    caughtUp,
    state: publicSyncState(updated),
  };
}

function emitOrdersChanged(accountId, payload = {}) {
  try {
    const io = getIO();
    if (!io) return;
    io.to('marketplace_staff').emit('allegro_orders_changed', {
      provider: 'allegro',
      allegroAccountId: clean(accountId, 64),
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      removedOrderIds: Array.isArray(payload.removedOrderIds) ? payload.removedOrderIds : [],
      resync: payload.resync === true,
      fetchedAt: new Date().toISOString(),
    });
  } catch (_) {
    // Socket delivery is an optimization. Mongo remains authoritative.
  }
}

async function markSyncFailure(accountId, error) {
  const id = clean(accountId, 64);
  const now = new Date();
  const message = clean(error?.message || error?.code || 'Allegro order sync failed', 1500);
  const errorCode = clean(error?.code || error?.args?.upstreamCode || '', 160);
  const traceId = clean(error?.args?.traceId || error?.allegroDiagnostic?.traceId || '', 256);
  const statusRaw = Number(error?.args?.upstreamStatus || 0);
  const httpStatus = Number.isFinite(statusRaw) && statusRaw > 0 ? statusRaw : null;
  const current = await AllegroOrderSyncState.findOne({ accountId: id }).select({ initialized: 1 }).lean();
  const setFields = {
    lastPollAt: now,
    lastError: message,
    lastErrorCode: errorCode,
    lastErrorTraceId: traceId,
    lastErrorHttpStatus: httpStatus,
  };
  // A journal/network failure after a successful bootstrap must not make the UI
  // claim that initial synchronization itself failed. Only an account that has
  // never completed bootstrap enters bootstrapState=error.
  if (!current?.initialized) setFields.bootstrapState = 'error';
  await Promise.allSettled([
    AllegroOrderSyncState.updateOne(
      { accountId: id },
      {
        $set: setFields,
        $inc: { consecutiveFailures: 1 },
      },
      { upsert: true },
    ),
    AllegroAccount.updateOne({ accountId: id }, { $set: { lastSyncError: message } }),
  ]);
}

async function setAllegroOrderRetryAt(accountId, retryAt = null) {
  const id = clean(accountId, 64);
  if (!id) return;
  const date = safeDate(retryAt);
  await AllegroOrderSyncState.updateOne(
    { accountId: id },
    { $set: { nextRetryAt: date } },
    { upsert: true },
  );
}

async function forceRebootstrapAllegroAccount(accountId) {
  const id = clean(accountId, 64);
  const account = await getAllegroAccount(id, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  return withLock(`allegro-order-sync:${id}`, async () => {
    const state = await AllegroOrderSyncState.findOne({ accountId: id }).lean();
    try {
      // Keep the current local projection and the last good cursor valid while
      // the authoritative snapshot is rebuilt. bootstrapAccount only replaces
      // actionable rows after the new SELLER snapshot has been fetched.
      await setAllegroOrderRetryAt(id, null);
      return await bootstrapAccount(account, state);
    } catch (error) {
      // A failed recovery attempt must not destroy the fact that this account
      // had a previously valid projection/cursor. Restore the completed marker
      // and let markSyncFailure attach the new diagnostic state.
      if (state?.initialized === true) {
        await AllegroOrderSyncState.updateOne(
          { accountId: id },
          { $set: { initialized: true, bootstrapState: 'complete' } },
          { upsert: true },
        );
      }
      await markSyncFailure(id, error);
      throw error;
    }
  }, { ttlMs: ORDER_SYNC_LOCK_TTL_MS, waitMs: 1_000 });
}

async function syncOneAllegroAccount(accountId) {
  const id = clean(accountId, 64);
  const account = await getAllegroAccount(id, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');

  return withLock(`allegro-order-sync:${id}`, async () => {
    const state = await AllegroOrderSyncState.findOne({ accountId: id }).lean();
    try {
      const lastSuccessAt = safeDate(state?.lastSuccessfulPollAt);
      const staleAfterOutage = state?.initialized === true
        && (!lastSuccessAt || Date.now() - lastSuccessAt.getTime() >= JOURNAL_OUTAGE_REBOOTSTRAP_MS);
      if (!state?.initialized || staleAfterOutage) return await bootstrapAccount(account, state);
      return await pollEventJournal(account, state);
    } catch (error) {
      await markSyncFailure(id, error);
      throw error;
    }
  }, { ttlMs: ORDER_SYNC_LOCK_TTL_MS, waitMs: 1_000 });
}

async function syncAllegroOrders({ accountId = '' } = {}) {
  const id = clean(accountId, 64);
  if (id) return { accounts: [await syncOneAllegroAccount(id)] };
  const accounts = await listAllegroAccounts({ includeDisabled: false });
  const enabled = accounts.filter((account) => account.enabled === true && account.authState === 'connected');
  const results = await Promise.all(enabled.map(async (account) => {
    try {
      return await syncOneAllegroAccount(account.accountId);
    } catch (error) {
      return { accountId: account.accountId, error: error?.code || error?.message || 'allegro_order_sync_failed' };
    }
  }));
  return { accounts: results };
}

function publicSyncState(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : (row || {});
  const now = Date.now();
  const initialized = value.initialized === true;
  const bootstrapState = clean(value.bootstrapState, 32) || 'pending';
  const lastSuccess = safeDate(value.lastSuccessfulPollAt);
  const nextRetry = safeDate(value.nextRetryAt);
  const consecutiveFailures = Math.max(0, Number(value.consecutiveFailures) || 0);
  const lagMs = lastSuccess ? Math.max(0, now - lastSuccess.getTime()) : null;
  const stale = initialized && (!lastSuccess || lagMs >= ORDER_SYNC_STALE_AFTER_MS);
  let health = 'pending';
  if (!initialized && bootstrapState === 'running') health = 'bootstrapping';
  else if (!initialized && bootstrapState === 'error') health = 'error';
  else if (nextRetry && nextRetry.getTime() > now) health = 'backoff';
  else if (stale) health = 'stale';
  else if (consecutiveFailures > 0 || clean(value.lastError, 1500)) health = 'degraded';
  else if (initialized) health = 'healthy';
  return {
    accountId: clean(value.accountId, 64),
    initialized,
    bootstrapState,
    health,
    stale,
    staleAfterMs: ORDER_SYNC_STALE_AFTER_MS,
    lagMs,
    cursorEventId: clean(value.cursorEventId, 128),
    cursorOccurredAt: value.cursorOccurredAt || null,
    lastPollAt: value.lastPollAt || null,
    lastSuccessfulPollAt: value.lastSuccessfulPollAt || null,
    nextRetryAt: value.nextRetryAt || null,
    lastBootstrapAt: value.lastBootstrapAt || null,
    lastEventCount: Math.max(0, Number(value.lastEventCount) || 0),
    lastOrderRefreshCount: Math.max(0, Number(value.lastOrderRefreshCount) || 0),
    consecutiveFailures,
    lastError: clean(value.lastError, 1500),
    lastErrorCode: clean(value.lastErrorCode, 160),
    lastErrorTraceId: clean(value.lastErrorTraceId, 256),
    lastErrorHttpStatus: Number.isFinite(Number(value.lastErrorHttpStatus)) && Number(value.lastErrorHttpStatus) > 0
      ? Number(value.lastErrorHttpStatus)
      : null,
  };
}

async function getAllegroOrderSyncStates(accountIds = []) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((value) => clean(value, 64)).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await AllegroOrderSyncState.find({ accountId: { $in: ids } }).lean();
  const byId = new Map(rows.map((row) => [clean(row.accountId, 64), publicSyncState(row)]));
  return ids.map((id) => byId.get(id) || publicSyncState({ accountId: id }));
}

function publicOrderFromRow(row, account = null) {
  if (!row) return null;
  const value = typeof row.toObject === 'function' ? row.toObject() : row;
  const preview = value.preview && typeof value.preview === 'object' ? value.preview : {};
  return {
    ...preview,
    allegroAccountId: clean(value.accountId || preview.allegroAccountId, 64),
    allegroAccountName: clean(account?.name || preview.allegroAccountName, 160),
    allegroAccountColor: clean(account?.color || preview.allegroAccountColor, 32),
    order_id: clean(value.checkoutFormId || preview.order_id, 128),
    revision: clean(value.revision || preview.revision, 128),
    order_status: clean(value.orderStatus || preview.order_status, 80),
    fulfillment_status: clean(value.fulfillmentStatus || preview.fulfillment_status, 80),
    fulfillment_provider_id: clean(value.fulfillmentProviderId || preview.fulfillment_provider_id, 80),
    upstreamStage: clean(value.upstreamStage || preview.upstreamStage, 32),
    workflowStage: clean(value.workflowStage, 32) || 'processing',
    upstreamReviewRequired: value.upstreamReviewRequired === true,
    warehouseStatus: clean(value.warehouseStatus, 80),
    sentBy: clean(value.sentBy, 128),
    sentByName: clean(value.sentByName, 240),
  };
}

async function getAllegroOrderPage({ accountId = '', workflowFilter = 'processing', sentBy = 'all', search = '', page = 1, pageSize = 10 } = {}) {
  const id = clean(accountId, 64);
  const selectedAccount = id ? await getAllegroAccount(id, { lean: true }) : null;
  const normalizedFilter = ['processing', 'deferred', 'sent', 'cancelled', 'updated'].includes(clean(workflowFilter, 32))
    ? clean(workflowFilter, 32)
    : 'processing';
  const currentPage = normalizePage(page);
  const limit = normalizePageSize(pageSize);
  const baseMatch = {};
  if (id) baseMatch.accountId = id;
  const term = clean(search, 300).toLowerCase();
  if (term) baseMatch.searchText = { $regex: escapedRegex(term), $options: 'i' };

  const [countsRows, updatedCount] = await Promise.all([
    AllegroOrderIndex.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$workflowStage', count: { $sum: 1 } } },
    ]),
    AllegroOrderIndex.countDocuments({ ...baseMatch, upstreamReviewRequired: true }),
  ]);
  const workflowCounts = { processing: 0, deferred: 0, sent: 0, cancelled: 0, updated: Number(updatedCount) || 0 };
  for (const row of countsRows) {
    if (Object.prototype.hasOwnProperty.call(workflowCounts, row._id)) workflowCounts[row._id] = Number(row.count) || 0;
  }

  const match = { ...baseMatch };
  if (normalizedFilter === 'updated') match.upstreamReviewRequired = true;
  else match.workflowStage = normalizedFilter;
  const normalizedSentBy = clean(sentBy, 128);
  if (normalizedFilter === 'sent' && normalizedSentBy && normalizedSentBy !== 'all') match.sentBy = normalizedSentBy;

  const total = await AllegroOrderIndex.countDocuments(match);
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(currentPage, pageCount);
  const rows = await AllegroOrderIndex.find(match)
    .sort({ orderSortDate: -1, checkoutFormId: 1 })
    .skip((safePage - 1) * limit)
    .limit(limit)
    .lean();
  const accountMap = new Map();
  if (selectedAccount) {
    accountMap.set(id, selectedAccount);
  } else {
    const visibleAccountIds = [...new Set(rows.map((row) => clean(row.accountId, 64)).filter(Boolean))];
    if (visibleAccountIds.length) {
      const accountRows = await AllegroAccount.find({ accountId: { $in: visibleAccountIds } })
        .select({ accountId: 1, name: 1, color: 1 })
        .lean();
      for (const account of accountRows) accountMap.set(clean(account.accountId, 64), account);
    }
  }
  const orders = rows.map((row) => publicOrderFromRow(row, accountMap.get(clean(row.accountId, 64)))).filter(Boolean);
  const refs = orders.map((order) => ({ allegroAccountId: order.allegroAccountId, orderId: order.order_id }));
  const pickingStates = await require('./allegroPicking').getPickingStates(refs);
  const sentByRows = await AllegroOrderIndex.aggregate([
    { $match: { ...(id ? { accountId: id } : {}), workflowStage: 'sent', sentBy: { $ne: '' } } },
    { $group: { _id: '$sentBy', name: { $first: '$sentByName' }, count: { $sum: 1 } } },
    { $sort: { name: 1, _id: 1 } },
  ]);
  return {
    orders,
    pickingStates,
    workflowCounts,
    sentByOptions: sentByRows.map((row) => ({ value: String(row._id || ''), label: String(row.name || row._id || ''), count: Number(row.count) || 0 })).filter((row) => row.value),
    page: safePage,
    pageCount,
    total,
    pageSize: limit,
  };
}

async function getLocalAllegroOrder(accountId, checkoutFormId) {
  const id = clean(accountId, 64);
  const orderId = clean(checkoutFormId, 128);
  if (!id || !orderId) throw appError('allegro_order_id_required');
  const [account, row] = await Promise.all([
    getAllegroAccount(id, { lean: true }),
    AllegroOrderIndex.findOne({ accountId: id, checkoutFormId: orderId }).lean(),
  ]);
  if (!row) throw appError('allegro_order_not_found');
  return publicOrderFromRow(row, account);
}

module.exports = {
  EVENT_LIMIT,
  MAX_EVENT_PAGES_PER_TICK,
  MAX_DETAIL_REFRESHES_PER_TICK,
  JOURNAL_OUTAGE_REBOOTSTRAP_MS,
  ORDER_SYNC_LOCK_TTL_MS,
  ORDER_SYNC_STALE_AFTER_MS,
  ACTIVE_FULFILLMENT_STATUSES,
  workflowStageForCheckoutForm,
  compactCheckoutForm,
  syncOneAllegroAccount,
  forceRebootstrapAllegroAccount,
  setAllegroOrderRetryAt,
  syncAllegroOrders,
  getAllegroOrderSyncStates,
  getAllegroOrderPage,
  getLocalAllegroOrder,
  publicSyncState,
};
