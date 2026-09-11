'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { getCatalogProductsByIds } = require('./catalog');
const { appError } = require('../../utils/errors');
const { CAPABILITIES } = require('./providers/contract');
const { getProviderAdapter, providerSupports } = require('./providers/registry');
const { effectivePrice, effectiveStock } = require('./publicationPolicy');

const MAX_PRODUCTS = 100;
const MAX_TARGETS = 25;

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeProductIds(raw) {
  return [...new Set((Array.isArray(raw) ? raw : [])
    .map((id) => text(id, 80))
    .filter((id) => mongoose.isValidObjectId(id)))]
    .slice(0, MAX_PRODUCTS);
}

function normalizeTargets(raw) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, MAX_TARGETS)) {
    const provider = text(item?.provider, 40).toLowerCase();
    const accountId = text(item?.accountId, 120);
    if (!provider || !accountId) continue;
    const adapter = getProviderAdapter(provider, { requireLive: true });
    if (!providerSupports(adapter, CAPABILITIES.LISTING_PREVIEW)) throw appError('commerce_provider_capability_not_supported');
    const key = `${provider}:${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, accountId });
  }
  return out;
}

function summarize(rows) {
  let ready = 0;
  let blocked = 0;
  let warnings = 0;
  for (const row of rows) {
    const issues = Array.isArray(row?.issues) ? row.issues : [];
    const errors = issues.filter((item) => item.level === 'error').length;
    const warningCount = issues.filter((item) => item.level === 'warning').length;
    warnings += warningCount;
    if (errors > 0) blocked += 1;
    else ready += 1;
  }
  return { total: rows.length, ready, blocked, warnings };
}

async function prepareProviderContexts(targets) {
  const byProvider = new Map();
  for (const target of targets) {
    if (!byProvider.has(target.provider)) byProvider.set(target.provider, []);
    byProvider.get(target.provider).push(target);
  }
  const contexts = new Map();
  await Promise.all([...byProvider.entries()].map(async ([providerId, providerTargets]) => {
    const adapter = getProviderAdapter(providerId, { requireLive: true });
    const context = await adapter.preparePublicationPreview({ targets: providerTargets });
    contexts.set(providerId, context || {});
  }));
  return contexts;
}

async function previewPublication(raw = {}) {
  const productIds = normalizeProductIds(raw.productIds);
  const targets = normalizeTargets(raw.targets);
  if (!productIds.length) throw appError('commerce_publication_products_required');
  if (!targets.length) throw appError('commerce_publication_targets_required');

  const [products, providerContexts] = await Promise.all([
    getCatalogProductsByIds(productIds),
    prepareProviderContexts(targets),
  ]);
  const productById = new Map(products.map((item) => [String(item.id), item]));

  const objectProductIds = productIds.map((id) => new mongoose.Types.ObjectId(id));
  const listings = await ChannelListing.find({
    commerceProductId: { $in: objectProductIds },
    $or: targets.map((target) => ({ provider: target.provider, accountId: target.accountId })),
  }).lean();
  const listingByKey = new Map(listings.map((row) => [
    `${String(row.commerceProductId)}:${row.provider}:${row.accountId}`,
    row,
  ]));

  const rows = [];
  for (const target of targets) {
    const adapter = getProviderAdapter(target.provider, { requireLive: true });
    const context = providerContexts.get(target.provider) || {};
    for (const productId of productIds) {
      const product = productById.get(productId) || null;
      const listing = listingByKey.get(`${productId}:${target.provider}:${target.accountId}`) || null;
      const providerRow = await adapter.previewPublicationRow({ product, listing, target, context });
      const issues = Array.isArray(providerRow?.issues) ? providerRow.issues : [];
      const errorCount = issues.filter((item) => item.level === 'error').length;
      const warningCount = issues.filter((item) => item.level === 'warning').length;
      const targetInfo = {
        ...(providerRow?.target || {}),
        provider: target.provider,
        providerName: adapter.name,
        accountId: target.accountId,
      };
      rows.push({
        productId,
        product: product ? {
          id: product.id,
          name: product.name,
          sku: product.sku,
          ean: product.ean,
          status: product.status,
          imageUrl: product.media?.[0]?.url || '',
          availableStock: product.availableStock,
        } : null,
        ...providerRow,
        target: targetInfo,
        ready: errorCount === 0,
        errorCount,
        warningCount,
        issues,
      });
    }
  }

  return {
    contractVersion: 1,
    stage: 'provider-core-v1',
    providerCalls: 0,
    safePreview: true,
    productCount: productIds.length,
    targetCount: targets.length,
    providers: [...new Set(targets.map((target) => target.provider))],
    summary: summarize(rows),
    rows,
  };
}

module.exports = {
  previewPublication,
  effectivePrice,
  effectiveStock,
};
