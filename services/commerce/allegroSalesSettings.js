'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { getAllegroAccount } = require('../allegroAccounts');
const { capabilityMatrix } = require('../allegroCapabilities');
const { allegroRequest } = require('../allegroHttpClient');
const { appError } = require('../../utils/errors');

const PROVIDER = 'allegro';
const MARKETPLACE_ID = 'allegro-pl';
const DEFAULT_HANDLING_TIME = 'PT24H';

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeId(value, max = 200) {
  return text(value, max);
}

function normalizeLocation(raw = {}) {
  const countryCode = text(raw.countryCode || 'PL', 2).toUpperCase();
  return {
    countryCode,
    province: text(raw.province, 80).toUpperCase(),
    city: text(raw.city, 160),
    postCode: text(raw.postCode, 32),
  };
}

function validHandlingTime(value) {
  const raw = text(value, 80).toUpperCase();
  // Allegro expects ISO-8601 duration. Keep the guard intentionally narrow
  // enough to catch typos while leaving Allegro as the final validator.
  return /^P(?=\d|T)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?)?$/.test(raw);
}

function locationIssues(location) {
  const issues = [];
  if (!/^[A-Z]{2}$/.test(location.countryCode)) issues.push('countryCode');
  if (!location.city) issues.push('city');
  if (location.countryCode === 'PL') {
    if (!location.province) issues.push('province');
    if (!/^\d{2}-\d{3}$/.test(location.postCode)) issues.push('postCode');
  }
  return issues;
}

function publicNamedOption(row = {}, extra = {}) {
  return {
    id: normalizeId(row.id),
    name: text(row.name, 500),
    ...extra,
  };
}

function publicShippingRate(row = {}) {
  return publicNamedOption(row, {
    managedByAllegro: row?.features?.managedByAllegro === true,
    isFulfillment: row?.features?.isFulfillment === true,
    marketplaces: (Array.isArray(row.marketplaces) ? row.marketplaces : [])
      .map((item) => text(item?.id, 80))
      .filter(Boolean)
      .slice(0, 20),
  });
}

function uniqueOptions(rows, mapper) {
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const item = mapper(row);
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function savedSalesSettings(listing) {
  const providerData = listing?.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  return allegro.salesSettings && typeof allegro.salesSettings === 'object' ? allegro.salesSettings : {};
}

function salesSettingsHash(settings) {
  const canonical = {
    shippingRateId: text(settings?.shippingRate?.id, 200),
    returnPolicyId: text(settings?.afterSalesServices?.returnPolicy?.id, 200),
    impliedWarrantyId: text(settings?.afterSalesServices?.impliedWarranty?.id, 200),
    warrantyId: text(settings?.afterSalesServices?.warranty?.id, 200),
    handlingTime: text(settings?.delivery?.handlingTime, 80).toUpperCase(),
    location: normalizeLocation(settings?.location || {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function requireReadAccount(accountId) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  if (account.authState !== 'connected') throw appError('allegro_account_authorization_required');
  const matrix = capabilityMatrix(account.scopes);
  if (!matrix.scopesKnown || matrix.capabilities.saleSettingsRead !== true) {
    throw appError('commerce_allegro_sales_settings_scope_required');
  }
  return account;
}

async function requireListing(productId, accountId) {
  const id = text(productId, 80);
  if (!mongoose.isValidObjectId(id)) throw appError('commerce_product_not_found');
  const listing = await ChannelListing.findOne({ commerceProductId: id, provider: PROVIDER, accountId });
  if (!listing) throw appError('commerce_allegro_mapping_not_ready');
  if (!text(listing.externalId, 200)) throw appError('commerce_allegro_draft_not_bound');
  const reconciliation = listing?.providerData?.allegro?.reconciliation;
  if (!reconciliation || reconciliation.readyForNextStage !== true) {
    throw appError('commerce_allegro_sales_settings_reconciliation_required');
  }
  return listing;
}

async function allegroRead(accountId, options) {
  const result = await allegroRequest(accountId, {
    method: 'GET',
    retryPolicy: 'safe',
    maxAttempts: 3,
    acceptLanguage: 'pl-PL',
    ...options,
  });
  return result.payload || {};
}

async function loadOptions(accountId) {
  // Keep at most four upstream calls in parallel; this matches the default
  // per-account concurrency guard in allegroHttpClient.
  const [shippingPayload, returnsPayload, impliedPayload, warrantiesPayload] = await Promise.all([
    allegroRead(accountId, {
      path: '/sale/shipping-rates',
      query: { marketplace: MARKETPLACE_ID },
      stage: 'commerce_sales_settings_shipping_rates',
    }),
    allegroRead(accountId, {
      path: '/after-sales-service-conditions/return-policies',
      query: { limit: 60, offset: 0 },
      stage: 'commerce_sales_settings_return_policies',
    }),
    allegroRead(accountId, {
      path: '/after-sales-service-conditions/implied-warranties',
      query: { limit: 60, offset: 0 },
      stage: 'commerce_sales_settings_implied_warranties',
    }),
    allegroRead(accountId, {
      path: '/after-sales-service-conditions/warranties',
      query: { limit: 60, offset: 0 },
      stage: 'commerce_sales_settings_warranties',
    }),
  ]);

  return {
    shippingRates: uniqueOptions(shippingPayload.shippingRates, publicShippingRate),
    returnPolicies: uniqueOptions(returnsPayload.returnPolicies, publicNamedOption),
    impliedWarranties: uniqueOptions(impliedPayload.impliedWarranties, publicNamedOption),
    warranties: uniqueOptions(warrantiesPayload.warranties, publicNamedOption),
  };
}

function optionById(options, id) {
  const wanted = normalizeId(id);
  return (Array.isArray(options) ? options : []).find((item) => item.id === wanted) || null;
}

function suggestedId(savedId, options) {
  if (optionById(options, savedId)) return normalizeId(savedId);
  return options.length === 1 ? options[0].id : '';
}

function publicSavedSettings(saved = {}) {
  return {
    state: text(saved.state, 40) || 'never',
    readyForApply: saved.readyForApply === true,
    desiredHash: text(saved.desiredHash, 100),
    updatedAt: saved.updatedAt || null,
    shippingRate: saved.shippingRate ? {
      id: text(saved.shippingRate.id, 200),
      name: text(saved.shippingRate.name, 500),
    } : null,
    afterSalesServices: {
      returnPolicy: saved?.afterSalesServices?.returnPolicy ? {
        id: text(saved.afterSalesServices.returnPolicy.id, 200),
        name: text(saved.afterSalesServices.returnPolicy.name, 500),
      } : null,
      impliedWarranty: saved?.afterSalesServices?.impliedWarranty ? {
        id: text(saved.afterSalesServices.impliedWarranty.id, 200),
        name: text(saved.afterSalesServices.impliedWarranty.name, 500),
      } : null,
      warranty: saved?.afterSalesServices?.warranty ? {
        id: text(saved.afterSalesServices.warranty.id, 200),
        name: text(saved.afterSalesServices.warranty.name, 500),
      } : null,
    },
    delivery: {
      handlingTime: text(saved?.delivery?.handlingTime, 80).toUpperCase(),
    },
    location: normalizeLocation(saved.location || {}),
  };
}

async function resolveAllegroSalesSettings(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!productId) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireReadAccount(accountId);
  const listing = await requireListing(productId, accountId);
  const options = await loadOptions(accountId);
  const saved = savedSalesSettings(listing);
  const savedPublic = publicSavedSettings(saved);

  const selection = {
    shippingRateId: suggestedId(savedPublic.shippingRate?.id, options.shippingRates),
    returnPolicyId: suggestedId(savedPublic.afterSalesServices.returnPolicy?.id, options.returnPolicies),
    impliedWarrantyId: suggestedId(savedPublic.afterSalesServices.impliedWarranty?.id, options.impliedWarranties),
    warrantyId: optionById(options.warranties, savedPublic.afterSalesServices.warranty?.id)?.id || '',
    handlingTime: savedPublic.delivery.handlingTime || DEFAULT_HANDLING_TIME,
    location: savedPublic.location,
  };

  return {
    stage: '3D.2',
    provider: PROVIDER,
    providerCalls: 4,
    productId,
    accountId,
    listingId: String(listing._id),
    offerId: text(listing.externalId, 200),
    marketplaceId: MARKETPLACE_ID,
    upstreamWriteCalls: 0,
    options,
    selection,
    saved: savedPublic,
    requirements: {
      shippingRate: true,
      returnPolicy: true,
      impliedWarranty: true,
      warranty: false,
      handlingTime: true,
      location: true,
    },
  };
}

async function saveAllegroSalesSettings(raw = {}) {
  const productId = text(raw.productId, 80);
  const accountId = text(raw.accountId, 80);
  if (!productId) throw appError('commerce_product_not_found');
  if (!accountId) throw appError('allegro_account_id_required');

  await requireReadAccount(accountId);
  const listing = await requireListing(productId, accountId);
  const options = await loadOptions(accountId);

  const shippingRate = optionById(options.shippingRates, raw.shippingRateId);
  const returnPolicy = optionById(options.returnPolicies, raw.returnPolicyId);
  const impliedWarranty = optionById(options.impliedWarranties, raw.impliedWarrantyId);
  const warrantyId = normalizeId(raw.warrantyId);
  const warranty = warrantyId ? optionById(options.warranties, warrantyId) : null;
  const handlingTime = text(raw.handlingTime || DEFAULT_HANDLING_TIME, 80).toUpperCase();
  const location = normalizeLocation(raw.location || {});

  const missing = [];
  if (!shippingRate) missing.push('cennik dostawy');
  if (!returnPolicy) missing.push('warunki zwrotu');
  if (!impliedWarranty) missing.push('warunki reklamacji');
  if (warrantyId && !warranty) missing.push('gwarancja');
  if (!validHandlingTime(handlingTime)) missing.push('czas wysyłki');
  const invalidLocation = locationIssues(location);
  if (invalidLocation.length) missing.push(`lokalizacja (${invalidLocation.join(', ')})`);
  if (missing.length) throw appError('commerce_allegro_sales_settings_invalid', { missing });

  const settings = {
    state: 'ready_local',
    readyForApply: true,
    shippingRate: { id: shippingRate.id, name: shippingRate.name },
    afterSalesServices: {
      returnPolicy: { id: returnPolicy.id, name: returnPolicy.name },
      impliedWarranty: { id: impliedWarranty.id, name: impliedWarranty.name },
      warranty: warranty ? { id: warranty.id, name: warranty.name } : null,
    },
    delivery: { handlingTime },
    location,
    appliedAt: null,
    appliedHash: '',
    updatedAt: new Date(),
  };
  settings.desiredHash = salesSettingsHash(settings);

  const providerData = listing.providerData && typeof listing.providerData === 'object' ? listing.providerData : {};
  const allegro = providerData.allegro && typeof providerData.allegro === 'object' ? providerData.allegro : {};
  providerData.allegro = { ...allegro, salesSettings: settings };
  listing.providerData = providerData;
  listing.markModified('providerData');
  listing.syncState.state = 'out_of_sync';
  // Do not overwrite the draft payload hash kept in ChannelListing.syncState.
  // Sales Settings own a separate desiredHash until the next stage applies them upstream.
  listing.syncState.lastError = '';
  await listing.save();

  return {
    stage: '3D.2',
    provider: PROVIDER,
    providerCalls: 4,
    upstreamWriteCalls: 0,
    productId,
    accountId,
    listingId: String(listing._id),
    offerId: text(listing.externalId, 200),
    settings: publicSavedSettings(settings),
    message: 'Sales Settings збережено локально. У Allegro зміни ще не застосовані.',
  };
}

module.exports = {
  resolveAllegroSalesSettings,
  saveAllegroSalesSettings,
  salesSettingsHash,
  validHandlingTime,
  normalizeLocation,
};
