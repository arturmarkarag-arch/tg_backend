'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const CommercePublicationJob = require('../../models/CommercePublicationJob');
const { getCatalogProductsByIds } = require('./catalog');
const { effectivePrice, effectiveStock } = require('./publicationPreview');
const { getReservationTotals } = require('./stockReservations');
const { buildDraftPayload, stableExternalKey } = require('./allegroDraftOffer');
const { desiredSnapshot, actualSnapshot, compareSnapshots } = require('./allegroOfferUpdatePreview');
const {
  buildSalesSettingsPatch,
  compareSalesSettings,
  salesSettingsSnapshotFromOffer,
} = require('./allegroSalesSettingsApply');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const PUBLIC_MIME = 'application/vnd.allegro.public.v1+json';
const MAX_ITEMS = 100;
const EVENT_LIMIT = 1000;
const OPEN_JOB_STATES = new Set(['reserved', 'sending', 'pending', 'unknown']);

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function whole(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function cents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function issue(code, message, { dimension = 'core', level = 'error', blocking = true, expected = null, actual = null } = {}) {
  return {
    code: text(code, 160),
    dimension: text(dimension, 80),
    level: level === 'warning' ? 'warning' : 'error',
    blocking: blocking === true,
    message: text(message, 1500),
    expected,
    actual,
  };
}

function normalizeItems(raw = {}) {
  const source = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  const out = [];
  for (const row of source) {
    const productId = text(row?.productId, 80);
    const accountId = text(row?.accountId, 80);
    if (!mongoose.isValidObjectId(productId) || !accountId) continue;
    const key = `${productId}:${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ productId, accountId, key });
    if (out.length >= MAX_ITEMS) break;
  }
  if (!out.length) throw appError('commerce_allegro_health_items_required');
  return out;
}

function listingStatusFromPublication(status) {
  switch (text(status, 40).toUpperCase()) {
    case 'ACTIVE': return 'active';
    case 'ACTIVATING': return 'publishing';
    case 'ENDED': return 'ended';
    case 'INACTIVE': return 'draft';
    default: return '';
  }
}

function latestJobsByListing(jobs = []) {
  const out = new Map();
  for (const job of jobs) {
    const key = `${String(job.channelListingId)}:${text(job.action, 100)}`;
    if (!out.has(key)) out.set(key, job);
  }
  return out;
}

function publicJob(job) {
  if (!job) return null;
  return {
    action: text(job.action, 100),
    state: text(job.state, 40),
    jobId: text(job.jobId, 100),
    commandId: text(job.providerOperationId, 120),
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    lastErrorCode: text(job.lastErrorCode, 200),
    lastError: text(job.lastError, 1200),
  };
}

function priceSnapshotFromOffer(offer = {}) {
  return {
    amount: text(offer?.sellingMode?.price?.amount, 40),
    currency: text(offer?.sellingMode?.price?.currency, 10).toUpperCase(),
  };
}

function priceMatches(desired = {}, actual = {}) {
  return text(desired.currency, 10).toUpperCase() === text(actual.currency, 10).toUpperCase()
    && cents(desired.value) === cents(actual.amount);
}

function savedSalesSettings(listing) {
  const pd = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = pd.allegro && typeof pd.allegro === 'object' ? pd.allegro : {};
  return allegro.salesSettings && typeof allegro.salesSettings === 'object' ? allegro.salesSettings : {};
}

function accountHealth(account) {
  const issues = [];
  const matrix = capabilityMatrix(account?.scopes || []);
  if (!account) issues.push(issue('account_not_found', 'Allegro-акаунт не знайдено.', { dimension: 'account' }));
  else {
    if (account.enabled !== true) issues.push(issue('account_disabled', 'Allegro-акаунт вимкнений.', { dimension: 'account' }));
    if (account.authState !== 'connected') issues.push(issue('oauth_not_connected', 'Allegro OAuth не підключений.', { dimension: 'account' }));
    if (!matrix.scopesKnown) issues.push(issue('scopes_unknown', 'Невідомий фактичний список OAuth scopes.', { dimension: 'account' }));
    if (matrix.scopesKnown && matrix.capabilities.saleOffersRead !== true) {
      issues.push(issue('sale_offers_read_missing', 'Токен не має allegro:api:sale:offers:read.', { dimension: 'account' }));
    }
    if (matrix.scopesKnown && matrix.capabilities.saleOffersWrite !== true) {
      issues.push(issue('sale_offers_write_missing', 'Токен не має allegro:api:sale:offers:write.', { dimension: 'account' }));
    }
    if (matrix.scopesKnown && matrix.capabilities.saleSettingsRead !== true) {
      issues.push(issue('sale_settings_read_missing', 'Токен не має allegro:api:sale:settings:read.', { dimension: 'account' }));
    }
  }
  const readReady = Boolean(account && account.enabled === true && account.authState === 'connected' && matrix.scopesKnown && matrix.capabilities.saleOffersRead === true);
  return { matrix, issues, readReady, ready: issues.filter((row) => row.blocking).length === 0 };
}

async function fetchRecentEvents(accountId) {
  try {
    const result = await allegroRequest(accountId, {
      method: 'GET',
      path: '/sale/offer-events',
      query: { limit: EVENT_LIMIT },
      retryPolicy: 'safe',
      maxAttempts: 3,
      stage: 'commerce_allegro_final_health_events',
      accept: PUBLIC_MIME,
    });
    return {
      ok: true,
      traceId: text(result.traceId, 256),
      requestId: text(result.requestId, 128),
      events: Array.isArray(result.payload?.offerEvents) ? result.payload.offerEvents : [],
    };
  } catch (error) {
    return {
      ok: false,
      events: [],
      errorCode: text(error?.code || error?.args?.upstreamCode, 160),
      error: text(error?.message, 1200),
    };
  }
}

function recentEventsForOffer(events, offerId) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => text(event?.offer?.id, 200) === text(offerId, 200))
    .slice(-20)
    .reverse()
    .map((event) => ({
      id: text(event.id, 200),
      type: text(event.type, 120),
      occurredAt: event.occurredAt || null,
      externalId: text(event?.offer?.external?.id, 100),
      marketplaces: Array.isArray(event?.offer?.marketplaces) ? event.offer.marketplaces.slice(0, 10) : [],
    }));
}

async function fetchOffer(accountId, offerId) {
  return allegroRequest(accountId, {
    method: 'GET',
    path: `/sale/product-offers/${encodeURIComponent(offerId)}`,
    retryPolicy: 'safe',
    maxAttempts: 3,
    stage: 'commerce_allegro_final_health_offer',
    accept: PUBLIC_MIME,
  });
}

function contentAndMappingHealth(product, listing, offer) {
  const externalKey = text(listing?.providerData?.allegro?.draftCreation?.externalKey, 100) || stableExternalKey(listing._id);
  const desired = desiredSnapshot(buildDraftPayload({ product, listing, externalKey }));
  const actual = actualSnapshot(offer);
  const compared = compareSnapshots(desired, actual);
  return {
    desired,
    actual,
    contentChanges: compared.contentChanges,
    mappingChanges: compared.mappingChanges,
    contentInSync: compared.contentChanges.length === 0,
    mappingInSync: compared.mappingChanges.length === 0,
  };
}

function salesSettingsHealth(listing, offer) {
  const settings = savedSalesSettings(listing);
  if (!settings.readyForApply) {
    return {
      configured: false,
      inSync: false,
      issues: [issue('sales_settings_not_configured', 'Sales Settings ще не підготовлені.', { dimension: 'sales_settings' })],
    };
  }
  try {
    const patch = buildSalesSettingsPatch(settings);
    const expected = {
      shippingRateId: text(patch?.delivery?.shippingRates?.id, 200),
      returnPolicyId: text(patch?.afterSalesServices?.returnPolicy?.id, 200),
      impliedWarrantyId: text(patch?.afterSalesServices?.impliedWarranty?.id, 200),
      warrantyId: text(patch?.afterSalesServices?.warranty?.id, 200),
      handlingTime: text(patch?.delivery?.handlingTime, 80).toUpperCase(),
      location: patch.location || {},
    };
    const actual = salesSettingsSnapshotFromOffer(offer);
    const rawIssues = compareSalesSettings(expected, actual);
    return {
      configured: true,
      inSync: rawIssues.length === 0,
      desiredHash: text(settings.desiredHash, 128),
      appliedHash: text(settings.appliedHash, 128),
      expected,
      actual,
      issues: rawIssues.map((row) => issue(row.code, row.message, {
        dimension: 'sales_settings',
        expected: row.expected,
        actual: row.actual,
      })),
    };
  } catch (error) {
    return {
      configured: false,
      inSync: false,
      issues: [issue('sales_settings_invalid', 'Збережені Sales Settings більше не проходять локальну валідацію.', { dimension: 'sales_settings' })],
    };
  }
}

function lifecycleHealth(listing, offer) {
  const publicationStatus = text(offer?.publication?.status, 40).toUpperCase();
  const expectedListingStatus = listingStatusFromPublication(publicationStatus);
  const issues = [];
  if (!publicationStatus) issues.push(issue('publication_status_missing', 'Allegro не повернув publication.status.', { dimension: 'lifecycle' }));
  if (expectedListingStatus && text(listing.status, 40) !== expectedListingStatus) {
    issues.push(issue('local_lifecycle_state_drift', 'Локальний ChannelListing.status не відповідає фактичному publication.status Allegro.', {
      dimension: 'lifecycle',
      expected: expectedListingStatus,
      actual: text(listing.status, 40),
    }));
  }
  return {
    publicationStatus,
    endedBy: text(offer?.publication?.endedBy, 100).toUpperCase(),
    expectedListingStatus,
    localListingStatus: text(listing.status, 40),
    inSync: issues.length === 0,
    issues,
  };
}

function summarizeState(issues, jobs) {
  if (jobs.some((job) => OPEN_JOB_STATES.has(job.state))) return 'pending';
  if (issues.some((row) => row.blocking)) return 'drift';
  if (issues.length) return 'warning';
  return 'healthy';
}

async function persistHealth(listing, health) {
  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = {
    ...allegro,
    health: {
      stage: '3D.7B',
      state: health.state,
      checkedAt: health.checkedAt,
      score: health.score,
      publicationStatus: health.lifecycle?.publicationStatus || '',
      issueCodes: health.issues.map((row) => row.code).slice(0, 50),
      pendingActions: health.jobs.filter((job) => OPEN_JOB_STATES.has(job.state)).map((job) => job.action).slice(0, 30),
      recentEventTypes: health.recentEvents.map((event) => event.type).slice(0, 20),
    },
  };
  listing.providerData = providerData;
  listing.markModified('providerData');
  await listing.save();
}

async function scanAllegroListingHealth(raw = {}) {
  const items = normalizeItems(raw);
  const productIds = [...new Set(items.map((row) => row.productId))];
  const [products, listings, reservationTotals] = await Promise.all([
    getCatalogProductsByIds(productIds),
    ChannelListing.find({
      provider: PROVIDER,
      $or: items.map((row) => ({ commerceProductId: row.productId, accountId: row.accountId })),
    }),
    getReservationTotals(productIds),
  ]);
  const productById = new Map(products.map((row) => [String(row.id), row]));
  const listingByKey = new Map(listings.map((row) => [`${String(row.commerceProductId)}:${row.accountId}`, row]));
  const listingIds = listings.map((row) => row._id);
  const jobs = listingIds.length
    ? await CommercePublicationJob.find({ channelListingId: { $in: listingIds } }).sort({ updatedAt: -1 }).lean()
    : [];

  const accountIds = [...new Set(items.map((row) => row.accountId))];
  const accountMap = new Map();
  const eventMap = new Map();
  let providerCalls = 0;
  let eventCalls = 0;
  for (const accountId of accountIds) {
    let account = null;
    try { account = await getAllegroAccount(accountId, { requireEnabled: false, lean: true }); } catch (_) { /* row health reports missing */ }
    const accountState = accountHealth(account);
    accountMap.set(accountId, { account, ...accountState });
    if (accountState.readReady) {
      const eventResult = await fetchRecentEvents(accountId);
      eventCalls += 1;
      providerCalls += 1;
      eventMap.set(accountId, eventResult);
    } else {
      eventMap.set(accountId, { ok: false, events: [], errorCode: 'account_not_read_ready', error: '' });
    }
  }

  const rows = [];
  for (const item of items) {
    const product = productById.get(item.productId) || null;
    const listing = listingByKey.get(item.key) || null;
    const accountState = accountMap.get(item.accountId) || { account: null, matrix: capabilityMatrix([]), issues: [], readReady: false, ready: false };
    const issues = [...accountState.issues];
    if (!product) issues.push(issue('product_not_found', 'Commerce Product не знайдено.', { dimension: 'catalog' }));
    if (product && product.status !== 'active') issues.push(issue('product_not_active', 'Commerce Product не active.', { dimension: 'catalog' }));
    if (!listing) issues.push(issue('listing_not_found', 'Allegro ChannelListing не знайдено.', { dimension: 'listing' }));
    if (listing && !text(listing.externalId, 200)) issues.push(issue('offer_not_bound', 'ChannelListing не має Allegro offerId.', { dimension: 'listing' }));

    const latestJobs = listing
      ? jobs
        .filter((job) => String(job.channelListingId) === String(listing._id))
        .filter((job, index, array) => array.findIndex((candidate) => candidate.action === job.action) === index)
        .map(publicJob)
      : [];
    for (const job of latestJobs) {
      if (OPEN_JOB_STATES.has(job.state)) {
        issues.push(issue('unresolved_job', `Є незавершена Commerce operation: ${job.action} (${job.state}).`, { dimension: 'jobs' }));
      } else if (job.state === 'failed') {
        issues.push(issue('latest_job_failed', `Остання operation ${job.action} завершилась failed.`, {
          dimension: 'jobs', level: 'warning', blocking: false,
        }));
      }
    }

    let offer = null;
    let offerTraceId = '';
    let offerRequestId = '';
    if (listing && text(listing.externalId, 200) && accountState.readReady) {
      try {
        const result = await fetchOffer(item.accountId, listing.externalId);
        providerCalls += 1;
        offer = result.payload || null;
        offerTraceId = text(result.traceId, 256);
        offerRequestId = text(result.requestId, 128);
        if (!text(offer?.id, 200)) issues.push(issue('offer_response_invalid', 'GET product-offer не повернув offer id.', { dimension: 'upstream' }));
      } catch (error) {
        providerCalls += 1;
        issues.push(issue('offer_read_failed', `Не вдалося прочитати offer з Allegro: ${text(error?.message, 800) || 'unknown error'}`, { dimension: 'upstream' }));
      }
    }

    let content = null;
    let mapping = null;
    let salesSettings = null;
    let price = null;
    let stock = null;
    let lifecycle = null;
    if (product && listing && offer) {
      if (text(offer?.external?.id, 100) !== (text(listing?.providerData?.allegro?.draftCreation?.externalKey, 100) || stableExternalKey(listing._id))) {
        issues.push(issue('external_id_drift', 'Allegro external.id не відповідає нашому stable listing key.', {
          dimension: 'identity',
          expected: text(listing?.providerData?.allegro?.draftCreation?.externalKey, 100) || stableExternalKey(listing._id),
          actual: text(offer?.external?.id, 100),
        }));
      }

      try {
        const cm = contentAndMappingHealth(product, listing, offer);
        content = { inSync: cm.contentInSync, changes: cm.contentChanges };
        mapping = { inSync: cm.mappingInSync, changes: cm.mappingChanges };
        for (const row of cm.contentChanges) issues.push(issue('content_drift', `${row.label} відрізняється від Commerce Catalog.`, { dimension: 'content', expected: row.expected, actual: row.actual }));
        for (const row of cm.mappingChanges) issues.push(issue('mapping_drift', `${row.label} відрізняється від Allegro mapping.`, { dimension: 'mapping', expected: row.expected, actual: row.actual }));
      } catch (error) {
        content = { inSync: false, changes: [] };
        mapping = { inSync: false, changes: [] };
        issues.push(issue('local_offer_payload_invalid', `Локальний Commerce payload не можна зібрати за поточним mapping: ${text(error?.message, 800) || 'validation failed'}`, { dimension: 'mapping' }));
      }

      salesSettings = salesSettingsHealth(listing, offer);
      issues.push(...salesSettings.issues);

      const desiredPrice = effectivePrice(product, listing);
      const actualPrice = priceSnapshotFromOffer(offer);
      const priceInSync = priceMatches(desiredPrice, actualPrice);
      price = { inSync: priceInSync, desired: desiredPrice, actual: actualPrice };
      if (!priceInSync) issues.push(issue('price_drift', 'Ціна Allegro відрізняється від бажаної Commerce price.', { dimension: 'price', expected: desiredPrice, actual: actualPrice }));

      const reservation = reservationTotals.byProductId.get(item.productId) || { reserved: 0, consumed: 0, unknown: 0, held: 0, rows: 0 };
      const desiredStock = effectiveStock(product, listing, reservation);
      const actualStock = { available: whole(offer?.stock?.available) };
      const stockInSync = whole(desiredStock.available) === actualStock.available;
      stock = {
        inSync: stockInSync,
        desired: { ...desiredStock, available: whole(desiredStock.available) },
        actual: actualStock,
        reservation,
      };
      if (!stockInSync) issues.push(issue('stock_drift', 'Allegro stock відрізняється від окремого Commerce Inventory після reservations/channel policy.', {
        dimension: 'stock',
        expected: whole(desiredStock.available),
        actual: actualStock.available,
      }));

      lifecycle = lifecycleHealth(listing, offer);
      issues.push(...lifecycle.issues);
    }

    const recentEventResult = eventMap.get(item.accountId) || { ok: false, events: [] };
    const recentEvents = offer ? recentEventsForOffer(recentEventResult.events, offer.id) : [];
    if (!recentEventResult.ok && accountState.readReady) {
      issues.push(issue('offer_events_unavailable', 'Журнал offer-events не вдалося прочитати; live offer check все одно виконано.', {
        dimension: 'events', level: 'warning', blocking: false,
      }));
    }

    const blocking = issues.filter((row) => row.blocking).length;
    const warnings = issues.filter((row) => !row.blocking).length;
    const state = summarizeState(issues, latestJobs);
    const score = Math.max(0, 100 - (blocking * 15) - (warnings * 3));
    const checkedAt = new Date().toISOString();
    const health = {
      stage: '3D.7B',
      productId: item.productId,
      productName: text(product?.name, 300),
      accountId: item.accountId,
      listingId: listing ? String(listing._id) : '',
      offerId: text(offer?.id || listing?.externalId, 200),
      state,
      score,
      checkedAt,
      blockingCount: blocking,
      warningCount: warnings,
      account: {
        ready: accountState.ready,
        readReady: accountState.readReady,
        enabled: accountState.account?.enabled === true,
        authState: text(accountState.account?.authState, 40),
        capabilities: accountState.matrix.capabilities,
      },
      content,
      mapping,
      salesSettings,
      price,
      stock,
      lifecycle,
      jobs: latestJobs,
      recentEvents,
      eventJournal: {
        ok: recentEventResult.ok === true,
        coverage: 'best_effort_last_24h',
        errorCode: text(recentEventResult.errorCode, 160),
        error: text(recentEventResult.error, 1200),
      },
      issues,
      traceId: offerTraceId,
      requestId: offerRequestId,
    };
    if (listing) await persistHealth(listing, health);
    rows.push(health);
  }

  return {
    stage: '3D.7B',
    readOnlyUpstream: true,
    providerWriteCalls: 0,
    providerCalls,
    offerEventCalls: eventCalls,
    eventJournalCoverage: 'best_effort_last_24h',
    summary: {
      total: rows.length,
      healthy: rows.filter((row) => row.state === 'healthy').length,
      warning: rows.filter((row) => row.state === 'warning').length,
      pending: rows.filter((row) => row.state === 'pending').length,
      drift: rows.filter((row) => row.state === 'drift').length,
      blockingIssues: rows.reduce((sum, row) => sum + row.blockingCount, 0),
      warnings: rows.reduce((sum, row) => sum + row.warningCount, 0),
    },
    rows,
  };
}

module.exports = {
  scanAllegroListingHealth,
};
