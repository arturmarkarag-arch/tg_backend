'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { getCatalogProductsByIds } = require('./catalog');
const { effectiveStock } = require('./publicationPreview');
const { refreshCommerceStockReservations, getReservationTotals } = require('./stockReservations');
const { stableExternalKey, requestHash } = require('./allegroDraftOffer');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const PUBLIC_MIME = 'application/vnd.allegro.public.v1+json';
const MAX_ITEMS = 250;
const OFFER_LOOKUP_CHUNK = 50;

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function wholeStock(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
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
  if (!out.length) throw appError('commerce_allegro_stock_sync_items_required');
  return out;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function normalizeStock(raw = {}) {
  return { available: wholeStock(raw?.available) };
}

function sameStock(left = {}, right = {}) {
  return wholeStock(left?.available) === wholeStock(right?.available);
}

async function requireStockAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleOffersRead !== true) {
    throw appError('commerce_allegro_stock_preview_scope_required');
  }
  return account;
}

async function fetchOffersByExternalKeys(accountId, externalKeys) {
  const offerByExternal = new Map();
  let providerCalls = 0;
  for (const part of chunks([...new Set(externalKeys.filter(Boolean))], OFFER_LOOKUP_CHUNK)) {
    if (!part.length) continue;
    const result = await allegroRequest(accountId, {
      method: 'GET',
      path: '/sale/offers',
      query: {
        'external.id': part,
        'publication.status': ['ACTIVE', 'INACTIVE', 'ACTIVATING', 'ENDED'],
        limit: Math.min(1000, Math.max(1, part.length)),
      },
      retryPolicy: 'safe',
      maxAttempts: 3,
      stage: 'commerce_stock_sync_offer_lookup',
      accept: PUBLIC_MIME,
    });
    providerCalls += 1;
    for (const offer of (Array.isArray(result.payload?.offers) ? result.payload.offers : [])) {
      const externalKey = text(offer?.external?.id, 100);
      if (externalKey) offerByExternal.set(externalKey, offer);
    }
  }
  return { offerByExternal, providerCalls };
}

async function loadLocalRows(items) {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const [products, listings] = await Promise.all([
    getCatalogProductsByIds(productIds),
    ChannelListing.find({
      provider: PROVIDER,
      $or: items.map((item) => ({ commerceProductId: item.productId, accountId: item.accountId })),
    }).lean(),
  ]);
  const productById = new Map(products.map((row) => [String(row.id), row]));
  const listingByKey = new Map(listings.map((row) => [`${String(row.commerceProductId)}:${row.accountId}`, row]));
  return items.map((item) => ({
    ...item,
    product: productById.get(item.productId) || null,
    listing: listingByKey.get(item.key) || null,
  }));
}

function localRowValidation(row, reservation = null) {
  const errors = [];
  const listing = row.listing;
  const product = row.product;
  if (!product) errors.push({ code: 'product_not_found', message: 'Commerce Product не знайдено.' });
  if (!listing) errors.push({ code: 'listing_not_found', message: 'Для товару немає Allegro ChannelListing.' });
  if (listing && !text(listing.externalId, 200)) errors.push({ code: 'offer_not_bound', message: 'ChannelListing не має Allegro offerId.' });

  const reservationInfo = reservation || { reserved: 0, consumed: 0, unknown: 0, held: 0, rows: 0 };
  const desiredRaw = product && listing
    ? effectiveStock(product, listing, reservationInfo)
    : { mode: 'inherit', physicalSource: 0, reservedUnits: 0, source: 0, buffer: 0, available: 0 };
  const desiredStock = {
    available: wholeStock(desiredRaw.available),
    physicalSource: wholeStock(desiredRaw.physicalSource),
    reservedUnits: wholeStock(desiredRaw.reservedUnits),
    source: wholeStock(desiredRaw.source),
    buffer: wholeStock(desiredRaw.buffer),
    mode: text(desiredRaw.mode || 'inherit', 40),
    requested: desiredRaw.requested == null ? null : wholeStock(desiredRaw.requested),
    cappedAt: desiredRaw.cappedAt == null ? null : wholeStock(desiredRaw.cappedAt),
    clamped: desiredRaw.clamped === true,
  };

  const externalKey = listing
    ? text(listing?.providerData?.allegro?.draftCreation?.externalKey, 100) || stableExternalKey(listing._id)
    : '';
  return { errors, desiredStock, reservation: reservationInfo, externalKey };
}

async function previewAllegroStockSync(raw = {}) {
  const items = normalizeItems(raw);
  // Local-only materialization: no Allegro/BaseLinker HTTP call. This refreshes
  // the provider-neutral reservation ledger from the order projections that the
  // existing schedulers already keep current.
  const reservationLedger = await refreshCommerceStockReservations();
  const reservationTotals = await getReservationTotals(items.map((item) => item.productId));
  const localRows = await loadLocalRows(items);
  const grouped = new Map();
  for (const row of localRows) {
    if (!grouped.has(row.accountId)) grouped.set(row.accountId, []);
    grouped.get(row.accountId).push(row);
  }

  const rows = [];
  let providerCalls = 0;
  for (const [accountId, accountRows] of grouped.entries()) {
    let accountError = null;
    try { await requireStockAccount(accountId); } catch (error) { accountError = error; }
    const prepared = accountRows.map((row) => ({
      row,
      local: localRowValidation(row, reservationTotals.byProductId.get(row.productId)),
    }));
    let offerByExternal = new Map();
    if (!accountError) {
      const lookup = await fetchOffersByExternalKeys(accountId, prepared.map((item) => item.local.externalKey));
      offerByExternal = lookup.offerByExternal;
      providerCalls += lookup.providerCalls;
    }

    for (const item of prepared) {
      const { row, local } = item;
      const errors = [...local.errors];
      const warnings = [];
      if (accountError) errors.push({
        code: text(accountError.code, 160) || 'account_unavailable',
        message: 'Allegro-акаунт не готовий до читання offers. Перевірте OAuth/scopes.',
      });
      const offer = local.externalKey ? offerByExternal.get(local.externalKey) : null;
      if (!accountError && !offer) errors.push({ code: 'offer_not_found_upstream', message: 'Не знайшли offer в Allegro за нашим external.id.' });

      const publicationStatus = text(offer?.publication?.status, 40).toUpperCase();
      const endedBy = text(offer?.publication?.endedBy, 80).toUpperCase();
      const actualStock = normalizeStock(offer?.stock || {});
      const inSync = Boolean(offer) && sameStock(local.desiredStock, actualStock);
      const endedNeedsReactivation = Boolean(offer) && publicationStatus === 'ENDED' && local.desiredStock.available > 0;
      const wouldEndOffer = Boolean(offer)
        && ['ACTIVE', 'ACTIVATING'].includes(publicationStatus)
        && local.desiredStock.available === 0
        && actualStock.available !== 0;

      if (offer && !['ACTIVE', 'ACTIVATING', 'ENDED'].includes(publicationStatus)) {
        errors.push({
          code: 'offer_not_stock_syncable_upstream',
          message: `Offer в Allegro має статус ${publicationStatus || 'UNKNOWN'}; Stock Sync для цього lifecycle state не виконуємо.`,
        });
      }
      if (endedNeedsReactivation) {
        errors.push({
          code: 'offer_reactivation_required',
          message: 'Offer завершений. Збільшення stock понад 0 саме по собі не активує ENDED offer; потрібен окремий lifecycle/reopen flow.',
        });
      }
      if (publicationStatus === 'ENDED' && local.desiredStock.available === 0) {
        warnings.push({
          code: 'offer_ended_zero_stock',
          message: `Offer уже ENDED${endedBy ? ` (${endedBy})` : ''}; stock=0 узгоджений, але lifecycle треба звіряти окремо.`,
        });
      }
      if (wouldEndOffer) {
        warnings.push({
          code: 'zero_stock_will_end_offer',
          message: 'FIXED stock=0 для ACTIVE/ACTIVATING offer асинхронно завершить offer в Allegro. Повернення stock > 0 не відновить його автоматично.',
        });
      }
      if (local.desiredStock.clamped) {
        warnings.push({
          code: 'channel_stock_clamped_to_warehouse',
          message: 'Channel stock policy просила більше одиниць, ніж фізично доступно. Значення затиснуто до warehouse source of truth.',
        });
      }

      const needsChange = errors.length === 0 && !inSync;
      const inventoryAccountingRequired = needsChange;
      if (local.reservation.reserved > 0) {
        warnings.push({
          code: 'commerce_active_reservations_subtracted',
          message: `Central ledger відняв ${wholeStock(local.reservation.reserved)} од. активних online-order reservations перед channel policy.`,
        });
      }
      if (local.reservation.consumed > 0) {
        warnings.push({
          code: 'commerce_consumed_reservations_held',
          message: `Ще ${wholeStock(local.reservation.consumed)} од. shipped orders утримуються як consumed, бо Product.quantity не має movement/reconciliation контракту.`,
        });
      }
      if (inventoryAccountingRequired) {
        warnings.push({
          code: 'commerce_inventory_consumption_contract_required',
          message: 'Reservation ledger уже LIVE, але upstream stock write ще locked: наступний етап має визначити, коли shipped/consumed одиниці вже фізично враховані в Product.quantity, щоб не віднімати їх двічі після ручної інвентаризації.',
        });
      }

      rows.push({
        productId: row.productId,
        productName: text(row.product?.name, 300),
        accountId,
        listingId: row.listing ? String(row.listing._id) : '',
        offerId: text(row.listing?.externalId, 200),
        externalKey: local.externalKey,
        publicationStatus,
        endedBy,
        desiredStock: local.desiredStock,
        actualStock,
        desiredHash: requestHash({ stock: { available: local.desiredStock.available } }),
        actualHash: requestHash({ stock: actualStock, publicationStatus, endedBy }),
        inSync,
        needsChange,
        wouldEndOffer,
        endedNeedsReactivation,
        reservation: local.reservation,
        inventoryAccountingRequired,
        writeReady: false,
        errors,
        warnings,
      });
    }
  }

  return {
    stage: '3D.6B',
    mode: 'preview_only',
    providerWriteCalls: 0,
    sourceOfTruth: 'warehouse_minus_central_reservations',
    reservationLedgerReady: true,
    inventoryConsumptionReady: false,
    reservationLedger: {
      startedAt: reservationLedger.startedAt,
      lastRefreshAt: reservationLedger.lastRefreshAt,
      heldRows: reservationLedger.heldRows,
      heldUnits: reservationLedger.heldUnits,
      reservedUnits: reservationLedger.reservedUnits,
      consumedUnits: reservationLedger.consumedUnits,
      unknownUnits: reservationLedger.unknownUnits,
      unresolvedHeldRows: reservationLedger.unresolvedHeldRows,
      ambiguousHeldRows: reservationLedger.ambiguousHeldRows,
      mappingCoverageReady: reservationLedger.mappingCoverageReady,
      writeReady: false,
    },
    providerCalls,
    summary: {
      total: rows.length,
      inSync: rows.filter((row) => row.inSync && !row.errors.length).length,
      changes: rows.filter((row) => row.needsChange).length,
      blocked: rows.filter((row) => row.errors.length > 0).length,
      writeBlockedByInventoryAccounting: rows.filter((row) => row.inventoryAccountingRequired).length,
      wouldEndOffers: rows.filter((row) => row.wouldEndOffer).length,
      requiresReactivation: rows.filter((row) => row.endedNeedsReactivation).length,
    },
    rows,
  };
}

module.exports = {
  previewAllegroStockSync,
  sameStock,
  wholeStock,
};
