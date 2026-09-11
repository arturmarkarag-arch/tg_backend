'use strict';

const mongoose = require('mongoose');
const ChannelListing = require('../../models/ChannelListing');
const { listAllegroAccounts } = require('../allegroAccounts');
const { getCatalogProductsByIds } = require('./catalog');
const { appError } = require('../../utils/errors');

const MAX_PRODUCTS = 100;
const MAX_TARGETS = 10;
const SUPPORTED_PROVIDERS = new Set(['allegro']);

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
    const accountId = text(item?.accountId, 80);
    if (!provider || !accountId) continue;
    if (!SUPPORTED_PROVIDERS.has(provider)) throw appError('commerce_publication_provider_unsupported');
    const key = `${provider}:${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, accountId });
  }
  return out;
}

function issue(code, message, level = 'error', meta = {}) {
  return { code, level, message, ...meta };
}

function titleWordCount(value) {
  return text(value, 1000).split(/\s+/).filter(Boolean).length;
}

function effectivePrice(product, listing) {
  const mode = listing?.price?.mode || 'inherit';
  const rawValue = mode === 'override' ? listing?.price?.value : product?.basePrice;
  const value = Number(rawValue || 0);
  const currency = text(
    mode === 'override' ? (listing?.price?.currency || product?.currency || 'PLN') : (product?.currency || 'PLN'),
    10,
  ).toUpperCase() || 'PLN';
  return { mode, value: Number.isFinite(value) ? value : 0, currency };
}

function effectiveStock(product, listing) {
  const source = Math.max(0, Math.floor(Number(product?.availableStock || 0)));
  const mode = listing?.stock?.mode || 'inherit';
  const buffer = Math.max(0, Math.floor(Number(listing?.stock?.buffer || 0)));
  if (mode === 'fixed') {
    return { mode, source, available: Math.max(0, Math.floor(Number(listing?.stock?.fixedQuantity || 0))) };
  }
  const inherited = Math.max(0, source - buffer);
  if (mode === 'capped') {
    const maxQuantity = Math.max(0, Math.floor(Number(listing?.stock?.maxQuantity || 0)));
    return { mode, source, available: Math.min(inherited, maxQuantity) };
  }
  return { mode: 'inherit', source, available: inherited };
}

function validateAllegroAccount(account) {
  const issues = [];
  if (!account) {
    issues.push(issue('account_not_found', 'Allegro-акаунт не знайдено.'));
    return issues;
  }
  if (account.enabled !== true) issues.push(issue('account_disabled', 'Allegro-акаунт вимкнений.'));
  if (account.authState !== 'connected') issues.push(issue('oauth_required', 'Allegro-акаунт потрібно перепідключити через OAuth.'));
  if (account.scopesKnown === true && account.capabilities?.saleOffersWrite !== true) {
    issues.push(issue(
      'missing_sale_offers_write_scope',
      'Токен не має allegro:api:sale:offers:write. Перепідключіть магазин через OAuth.',
      'error',
      { scope: 'allegro:api:sale:offers:write' },
    ));
  }
  if (account.scopesKnown !== true) {
    issues.push(issue(
      'scope_state_unknown',
      'Список OAuth scope для цього підключення невідомий. Перед реальною публікацією акаунт треба перепідключити.',
      'error',
    ));
  }
  return issues;
}

function isLikelyGtin(value) {
  const normalized = text(value, 120).replace(/\s+/g, '');
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(normalized);
}

function validateProductForAllegro(product, listing) {
  const issues = [];
  if (!product) {
    issues.push(issue('product_not_found', 'Товар Commerce Catalog не знайдено.'));
    return { issues, price: { value: 0, currency: 'PLN' }, stock: { available: 0 }, strategy: 'unknown' };
  }

  const title = text(listing?.titleOverride || product.name, 500);
  const price = effectivePrice(product, listing);
  const stock = effectiveStock(product, listing);
  const ean = text(product.ean, 120);
  const images = Array.isArray(product.media) ? product.media.filter((item) => text(item?.url, 2000)) : [];
  const gtinReady = isLikelyGtin(ean);
  const strategy = gtinReady ? 'gtin' : 'category_mapping';

  if (product.status !== 'active') {
    issues.push(issue('product_not_active', 'Товар має бути активним у Commerce Catalog перед публікацією.'));
  }
  if (title.length < 12 || title.length > 75 || titleWordCount(title) < 3) {
    issues.push(issue('title_invalid', 'Для Allegro назва offer повинна мати 12–75 символів і щонайменше 3 слова.', 'error', { field: 'title' }));
  }
  if (!(price.value > 0)) issues.push(issue('price_required', 'Вкажіть ціну більшу за 0.', 'error', { field: 'price' }));
  if (price.currency !== 'PLN') {
    issues.push(issue('currency_not_supported_yet', 'На цьому етапі outbound для Allegro налаштований лише для базового marketplace allegro-pl у PLN.', 'error', { field: 'currency' }));
  }
  if (!(stock.available > 0)) issues.push(issue('stock_required', 'Для публікації зараз немає доступного залишку.', 'error', { field: 'stock' }));

  if (!ean) {
    issues.push(issue(
      'category_mapping_required',
      'Немає GTIN/EAN. Потрібно вибрати категорію Allegro та заповнити її обов’язкові параметри.',
      'error',
      { nextStage: 'category_mapping' },
    ));
  } else if (!gtinReady) {
    issues.push(issue(
      'gtin_invalid',
      'EAN/GTIN має некоректний формат. Перевірте код або використайте шлях через категорію та параметри Allegro.',
      'error',
      { field: 'ean', nextStage: 'category_mapping' },
    ));
  } else {
    issues.push(issue(
      'upstream_product_validation_pending',
      'GTIN готовий для пошуку в Каталозі Allegro. Остаточні обов’язкові параметри перевіримо через Allegro на наступному етапі.',
      'warning',
      { nextStage: 'category_mapping' },
    ));
  }

  if (!images.length) {
    issues.push(issue(
      'images_missing',
      gtinReady ? 'У нашому каталозі немає фото. Якщо Allegro знайде продукт за GTIN, фото можуть прийти з Каталогу Allegro; інакше потрібно додати фото.' : 'Для продукту без валідного GTIN потрібно додати хоча б одне фото.',
      gtinReady ? 'warning' : 'error',
      { field: 'media' },
    ));
  }
  if (!text(listing?.descriptionOverride || product.description, 20000)) {
    issues.push(issue('description_missing', 'Опис не заповнений. Для відомого продукту Allegro може використати дані каталогу, але власний опис бажаний.', 'warning', { field: 'description' }));
  }

  return { issues, price, stock, strategy };
}

function summarize(rows) {
  let ready = 0;
  let blocked = 0;
  let warnings = 0;
  for (const row of rows) {
    const errors = row.issues.filter((item) => item.level === 'error').length;
    const warningCount = row.issues.filter((item) => item.level === 'warning').length;
    warnings += warningCount;
    if (errors > 0) blocked += 1;
    else ready += 1;
  }
  return { total: rows.length, ready, blocked, warnings };
}

async function previewPublication(raw = {}) {
  const productIds = normalizeProductIds(raw.productIds);
  const targets = normalizeTargets(raw.targets);
  if (!productIds.length) throw appError('commerce_publication_products_required');
  if (!targets.length) throw appError('commerce_publication_targets_required');

  const [products, allegroAccounts] = await Promise.all([
    getCatalogProductsByIds(productIds),
    listAllegroAccounts({ includeDisabled: true }),
  ]);
  const productById = new Map(products.map((item) => [String(item.id), item]));
  const allegroById = new Map(allegroAccounts.map((item) => [String(item.accountId), item]));

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
    const account = target.provider === 'allegro' ? allegroById.get(target.accountId) : null;
    const accountIssues = target.provider === 'allegro' ? validateAllegroAccount(account) : [];
    for (const productId of productIds) {
      const product = productById.get(productId) || null;
      const listing = listingByKey.get(`${productId}:${target.provider}:${target.accountId}`) || null;
      const validation = target.provider === 'allegro'
        ? validateProductForAllegro(product, listing)
        : { issues: [], price: {}, stock: {}, strategy: 'unknown' };
      const issues = [...accountIssues, ...validation.issues];
      const errorCount = issues.filter((item) => item.level === 'error').length;
      const warningCount = issues.filter((item) => item.level === 'warning').length;
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
        target: {
          provider: target.provider,
          accountId: target.accountId,
          accountName: account?.name || account?.login || target.accountId,
          connected: account?.authState === 'connected',
          enabled: account?.enabled === true,
          saleOffersWrite: account?.capabilities?.saleOffersWrite === true,
        },
        listing: listing ? {
          id: String(listing._id),
          externalId: text(listing.externalId, 200),
          status: text(listing.status, 40) || 'draft',
        } : null,
        mode: listing?.externalId ? 'update' : 'create',
        strategy: validation.strategy,
        effectivePrice: validation.price,
        effectiveStock: validation.stock,
        ready: errorCount === 0,
        errorCount,
        warningCount,
        issues,
      });
    }
  }

  return {
    stage: '3A',
    providerCalls: 0,
    safePreview: true,
    productCount: productIds.length,
    targetCount: targets.length,
    summary: summarize(rows),
    rows,
  };
}

module.exports = {
  previewPublication,
  validateProductForAllegro,
  validateAllegroAccount,
  effectivePrice,
  effectiveStock,
};
