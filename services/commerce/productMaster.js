'use strict';

const mongoose = require('mongoose');
const CommerceCategory = require('../../models/CommerceCategory');
const { appError } = require('../../utils/errors');

const IDENTIFIER_KINDS = new Set(['gtin', 'ean', 'upc', 'isbn', 'issn', 'mpn', 'custom']);
const CONDITION_VALUES = new Set(['unknown', 'new', 'used', 'refurbished']);
const VALUE_TYPES = new Set(['text', 'number', 'boolean', 'select', 'multi_select']);
const PRODUCT_MASTER_CONTRACT_VERSION = 1;

function text(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeIdentifierValue(value) {
  return text(value, 180).replace(/\s+/g, '').toUpperCase();
}

function gtinCheck(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return { validFormat: false, validChecksum: false };
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return { validFormat: true, validChecksum: check === Number(digits[digits.length - 1]) };
}

function normalizeIdentifiers(raw, legacyEan = '') {
  const source = Array.isArray(raw) ? raw : [];
  const items = [];
  const seen = new Set();
  for (const item of source.slice(0, 40)) {
    const kind = IDENTIFIER_KINDS.has(String(item?.kind || '').toLowerCase()) ? String(item.kind).toLowerCase() : 'custom';
    const value = text(item?.value, 180);
    const normalized = normalizeIdentifierValue(value);
    if (!normalized) continue;
    const key = `${kind}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind,
      value,
      normalized,
      label: text(item?.label, 120),
      primary: item?.primary === true,
      source: ['catalog', 'warehouse', 'provider', 'manual'].includes(item?.source) ? item.source : 'manual',
    });
  }

  const ean = text(legacyEan, 120);
  const eanNormalized = normalizeIdentifierValue(ean);
  if (eanNormalized && !items.some((item) => ['gtin', 'ean', 'upc', 'isbn', 'issn'].includes(item.kind) && item.normalized === eanNormalized)) {
    items.unshift({ kind: 'ean', value: ean, normalized: eanNormalized, label: 'EAN / GTIN', primary: true, source: 'manual' });
  }

  if (items.length && !items.some((item) => item.primary)) items[0].primary = true;
  let primarySeen = false;
  for (const item of items) {
    if (!item.primary) continue;
    if (!primarySeen) primarySeen = true;
    else item.primary = false;
  }
  return items;
}

function legacyEanFromIdentifiers(identifiers, fallback = '') {
  const preferred = (identifiers || []).find((item) => item.primary && ['gtin', 'ean', 'upc', 'isbn', 'issn'].includes(item.kind))
    || (identifiers || []).find((item) => ['gtin', 'ean', 'upc', 'isbn', 'issn'].includes(item.kind));
  return text(preferred?.value || fallback, 120);
}

function normalizeMedia(raw, productName = '') {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, 30)) {
    const url = text(typeof item === 'string' ? item : item?.url, 2200);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      type: 'image',
      url,
      alt: text(item?.alt || productName, 300),
      source: ['catalog', 'warehouse', 'provider', 'manual'].includes(item?.source) ? item.source : 'catalog',
      role: item?.role === 'primary' ? 'primary' : 'gallery',
      position: Number.isFinite(Number(item?.position)) ? Math.max(0, Math.floor(Number(item.position))) : out.length,
      sourceRef: text(item?.sourceRef, 300),
    });
  }
  out.sort((a, b) => a.position - b.position);
  let primaryIndex = out.findIndex((item) => item.role === 'primary');
  if (primaryIndex < 0 && out.length) primaryIndex = 0;
  if (primaryIndex > 0) {
    const [primary] = out.splice(primaryIndex, 1);
    out.unshift(primary);
  }
  return out.map((item, index) => ({
    ...item,
    role: index === 0 ? 'primary' : 'gallery',
    position: index,
  }));
}

function normalizeAttributeValues(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, 250)) {
    const key = text(item?.key, 120).toLocaleLowerCase('en-US').replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const valueType = VALUE_TYPES.has(item?.valueType) ? item.valueType : 'text';
    let value = item?.value;
    if (valueType === 'number') {
      const n = Number(value);
      value = Number.isFinite(n) ? n : '';
    } else if (valueType === 'boolean') {
      value = value === true || value === 'true';
    } else if (valueType === 'multi_select') {
      value = Array.isArray(value) ? value.map((v) => text(v, 300)).filter(Boolean).slice(0, 50) : [];
    } else {
      value = text(value, 2000);
    }
    out.push({
      key,
      label: text(item?.label || key, 200),
      valueType,
      value,
      unit: text(item?.unit, 50),
      group: text(item?.group, 120),
      position: out.length,
      source: ['catalog', 'warehouse', 'provider', 'manual'].includes(item?.source) ? item.source : 'manual',
    });
  }
  return out;
}

function nonNegative(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw appError('validation_failed', { field });
  return n;
}

function normalizeDimensions(raw = {}, prefix = 'physical') {
  return {
    lengthMm: nonNegative(raw?.lengthMm, `${prefix}.lengthMm`),
    widthMm: nonNegative(raw?.widthMm, `${prefix}.widthMm`),
    heightMm: nonNegative(raw?.heightMm, `${prefix}.heightMm`),
  };
}

function normalizePhysical(raw = {}) {
  return {
    weightG: nonNegative(raw?.weightG, 'physical.weightG'),
    packageWeightG: nonNegative(raw?.packageWeightG, 'physical.packageWeightG'),
    dimensions: normalizeDimensions(raw?.dimensions || {}, 'physical.dimensions'),
    packageDimensions: normalizeDimensions(raw?.packageDimensions || {}, 'physical.packageDimensions'),
  };
}

function normalizeCondition(value) {
  const condition = text(value || 'unknown', 40).toLowerCase();
  if (!CONDITION_VALUES.has(condition)) throw appError('validation_failed', { field: 'condition' });
  return condition;
}

async function normalizeCategoryId(value) {
  const raw = text(value, 80);
  if (!raw) return null;
  if (!mongoose.isValidObjectId(raw)) throw appError('commerce_category_not_found');
  const exists = await CommerceCategory.exists({ _id: raw, status: { $ne: 'archived' } });
  if (!exists) throw appError('commerce_category_not_found');
  return raw;
}

function readinessCheck(id, label, state, severity = 'recommended', details = {}) {
  return { id, label, state: Boolean(state), severity, ...details };
}

function computeProductMasterReadiness(product = {}) {
  const identifiers = normalizeIdentifiers(product.identifiers, product.ean);
  const primaryCode = identifiers.find((item) => item.primary) || identifiers[0] || null;
  const gtinLike = identifiers.find((item) => ['gtin', 'ean', 'upc'].includes(item.kind)) || null;
  const gtinValidation = gtinLike ? gtinCheck(gtinLike.value) : { validFormat: false, validChecksum: false };
  const media = normalizeMedia(product.media, product.name);
  const primaryMedia = media.find((item) => item.role === 'primary') || media[0] || null;
  const checks = [
    readinessCheck('identity.name', 'Назва', Boolean(text(product.name, 500)), 'required'),
    readinessCheck('identity.sku', 'SKU', Boolean(text(product.sku, 120)), 'recommended'),
    readinessCheck('identity.code', 'EAN / GTIN / код', Boolean(primaryCode), 'recommended'),
    readinessCheck('identity.brand', 'Бренд', Boolean(text(product.brand, 300)), 'recommended'),
    readinessCheck('media.primary', 'Головне фото', Boolean(primaryMedia?.url), 'required'),
    readinessCheck('media.gallery', 'Галерея', media.length > 1, 'recommended', { count: media.length }),
    readinessCheck('taxonomy.category', 'Власна категорія', Boolean(product.categoryId), 'recommended'),
    readinessCheck('content.description', 'Опис', text(product.description, 20000).length >= 20, 'recommended'),
    readinessCheck('pricing.base', 'Базова ціна', Number(product.basePrice || 0) > 0, 'required'),
    readinessCheck('inventory.online', 'Інтернет-склад', Number(product?.commerceInventory?.onHand ?? product?.availableStock ?? 0) >= 0, 'required'),
  ];
  if (gtinLike) {
    checks.push(readinessCheck('identity.gtin_checksum', 'Контрольна цифра GTIN', gtinValidation.validFormat && gtinValidation.validChecksum, 'warning', gtinValidation));
  }
  const required = checks.filter((item) => item.severity === 'required');
  const recommended = checks.filter((item) => item.severity !== 'required');
  const requiredReady = required.every((item) => item.state);
  const totalWeight = (required.length * 2) + recommended.length;
  const readyWeight = (required.filter((item) => item.state).length * 2) + recommended.filter((item) => item.state).length;
  const score = totalWeight ? Math.round((readyWeight / totalWeight) * 100) : 100;
  return {
    contractVersion: PRODUCT_MASTER_CONTRACT_VERSION,
    state: requiredReady ? (score === 100 ? 'complete' : 'ready') : 'incomplete',
    score,
    requiredReady,
    primaryIdentifier: primaryCode ? { kind: primaryCode.kind, value: primaryCode.value } : null,
    primaryImage: primaryMedia?.url || '',
    checks,
    missingRequired: required.filter((item) => !item.state).map((item) => item.id),
  };
}

module.exports = {
  PRODUCT_MASTER_CONTRACT_VERSION,
  IDENTIFIER_KINDS,
  normalizeIdentifiers,
  legacyEanFromIdentifiers,
  normalizeMedia,
  normalizeAttributeValues,
  normalizePhysical,
  normalizeCondition,
  normalizeCategoryId,
  computeProductMasterReadiness,
  gtinCheck,
};
