'use strict';

const mongoose = require('mongoose');
const CommerceProduct = require('../../models/CommerceProduct');
const CommerceCategory = require('../../models/CommerceCategory');
const CommerceInventoryItem = require('../../models/CommerceInventoryItem');
const ChannelListing = require('../../models/ChannelListing');
const Product = require('../../models/Product');
const { appError } = require('../../utils/errors');
const {
  normalizeIdentifiers,
  legacyEanFromIdentifiers,
  normalizeMedia: normalizeProductMedia,
  normalizeAttributeValues,
  normalizePhysical,
  normalizeCondition,
  normalizeCategoryId,
  computeProductMasterReadiness,
} = require('./productMaster');

const VALID_STATUSES = new Set(['draft', 'active', 'archived']);
const VALID_CURRENCIES = new Set(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
const MAX_PAGE_SIZE = 100;
const MAX_IMPORT_BATCH = 100;

function text(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actorFromRequest(req) {
  const user = req?.telegramUser || req?.user || {};
  return {
    telegramId: String(req?.telegramId || user.telegramId || ''),
    name: text(user.name || user.fullName || user.username || '', 200),
  };
}

function normalizeAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).slice(0, 200));
}

function normalizeInventoryQuantity(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw appError('validation_failed', { field: 'inventoryQuantity' });
  return Math.max(0, Math.floor(n));
}

function normalizeWarehouseBindings(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const binding of raw.slice(0, 100)) {
    const productId = String(binding?.productId || '').trim();
    if (!mongoose.isValidObjectId(productId) || seen.has(productId)) continue;
    seen.add(productId);
    const unitsPerItem = Number(binding?.unitsPerItem);
    const stockBuffer = Number(binding?.stockBuffer);
    out.push({
      productId,
      unitsPerItem: Number.isFinite(unitsPerItem) && unitsPerItem > 0 ? unitsPerItem : 1,
      stockBuffer: Number.isFinite(stockBuffer) && stockBuffer >= 0 ? stockBuffer : 0,
      enabled: binding?.enabled !== false,
    });
  }
  return out;
}

async function normalizePayload(raw = {}, { partial = false, current = {} } = {}) {
  const patch = {};
  const set = (key, value) => { patch[key] = value; };

  if (!partial || raw.name !== undefined) {
    const name = text(raw.name, 500);
    if (!name) throw appError('commerce_product_name_required');
    set('name', name);
  }
  if (!partial || raw.sku !== undefined) set('sku', text(raw.sku, 120));

  if (!partial || raw.identifiers !== undefined || raw.ean !== undefined) {
    const sourceIdentifiers = raw.identifiers !== undefined ? raw.identifiers : current.identifiers;
    const legacyEan = raw.ean !== undefined ? raw.ean : current.ean;
    const identifiers = normalizeIdentifiers(sourceIdentifiers, legacyEan);
    set('identifiers', identifiers);
    set('ean', legacyEanFromIdentifiers(identifiers, legacyEan));
  }

  if (!partial || raw.description !== undefined) set('description', text(raw.description, 40000));
  if (!partial || raw.brand !== undefined) set('brand', text(raw.brand, 300));
  if (!partial || raw.language !== undefined) set('language', text(raw.language || 'pl-PL', 35) || 'pl-PL');
  if (!partial || raw.condition !== undefined) set('condition', normalizeCondition(raw.condition));
  if (!partial || raw.categoryId !== undefined) set('categoryId', await normalizeCategoryId(raw.categoryId));
  if (!partial || raw.basePrice !== undefined) {
    const basePrice = Number(raw.basePrice ?? 0);
    if (!Number.isFinite(basePrice) || basePrice < 0) throw appError('validation_failed', { field: 'basePrice' });
    set('basePrice', basePrice);
  }
  if (!partial || raw.currency !== undefined) {
    const currency = text(raw.currency || 'PLN', 10).toUpperCase();
    if (!VALID_CURRENCIES.has(currency)) throw appError('validation_failed', { field: 'currency' });
    set('currency', currency);
  }
  if (!partial || raw.status !== undefined) {
    const status = text(raw.status || 'draft', 30).toLowerCase();
    if (!VALID_STATUSES.has(status)) throw appError('validation_failed', { field: 'status' });
    set('status', status);
  }
  if (!partial || raw.media !== undefined) set('media', normalizeProductMedia(raw.media, raw.name ?? current.name));
  if (!partial || raw.attributes !== undefined) set('attributes', normalizeAttributes(raw.attributes));
  if (!partial || raw.attributeValues !== undefined) set('attributeValues', normalizeAttributeValues(raw.attributeValues));
  if (!partial || raw.physical !== undefined) set('physical', normalizePhysical(raw.physical || {}));
  if (!partial || raw.warehouseBindings !== undefined) set('warehouseBindings', normalizeWarehouseBindings(raw.warehouseBindings));
  return patch;
}

function bestWarehouseImage(product) {
  return text(product?.originalImageUrl || product?.localImageUrl || product?.imageUrls?.[0] || '', 2000);
}

async function assertWarehouseBindingsExist(bindings) {
  if (!Array.isArray(bindings) || !bindings.length) return;
  const ids = [...new Set(bindings.map((binding) => String(binding.productId || '')).filter(Boolean))];
  const count = await Product.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) throw appError('commerce_warehouse_product_not_found');
}

async function hydrateProducts(rawProducts) {
  const docs = Array.isArray(rawProducts) ? rawProducts : [];
  if (!docs.length) return [];

  const sourceProductIds = [...new Set(docs.flatMap((doc) => (doc.warehouseBindings || [])
    .map((binding) => String(binding.productId || ''))
    .filter((id) => mongoose.isValidObjectId(id))))];
  const commerceIds = docs.map((doc) => doc._id);

  const categoryIds = [...new Set(docs.map((doc) => String(doc.categoryId || '')).filter((id) => mongoose.isValidObjectId(id)))];
  const [sourceRows, inventoryRows, listingRows, categoryRows] = await Promise.all([
    sourceProductIds.length
      ? Product.find({ _id: { $in: sourceProductIds } })
        .select('_id name orderNumber barcode quantity status warehouse originalImageUrl localImageUrl imageUrls')
        .lean()
      : [],
    CommerceInventoryItem.find({ commerceProductId: { $in: commerceIds } }).lean(),
    ChannelListing.aggregate([
      { $match: { commerceProductId: { $in: commerceIds } } },
      {
        $group: {
          _id: '$commerceProductId',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          errors: { $sum: { $cond: [{ $in: ['$status', ['validation_error', 'error']] }, 1, 0] } },
        },
      },
    ]),
    categoryIds.length ? CommerceCategory.find({ _id: { $in: categoryIds } }).select('_id name slug parentId status').lean() : [],
  ]);

  const sourceById = new Map(sourceRows.map((row) => [String(row._id), row]));
  const inventoryByProductId = new Map(inventoryRows.map((row) => [String(row.commerceProductId), row]));
  const listingsById = new Map(listingRows.map((row) => [String(row._id), row]));
  const categoryById = new Map(categoryRows.map((row) => [String(row._id), row]));

  return docs.map((doc) => {
    const bindings = (doc.warehouseBindings || []).map((binding) => {
      const bindingObj = typeof binding.toObject === 'function' ? binding.toObject() : binding;
      const sourceProduct = sourceById.get(String(bindingObj.productId || '')) || null;
      return {
        productId: String(bindingObj.productId || ''),
        unitsPerItem: Number(bindingObj.unitsPerItem || 1),
        stockBuffer: Number(bindingObj.stockBuffer || 0),
        enabled: bindingObj.enabled !== false,
        // Source/provenance only. quantity is displayed for reference and is never
        // used to calculate Commerce inventory or marketplace stock.
        warehouseProduct: sourceProduct ? {
          id: String(sourceProduct._id),
          name: sourceProduct.name || '',
          orderNumber: sourceProduct.orderNumber ?? null,
          barcode: sourceProduct.barcode || '',
          quantity: Number(sourceProduct.quantity || 0),
          status: sourceProduct.status || '',
          warehouse: sourceProduct.warehouse || '',
          imageUrl: bestWarehouseImage(sourceProduct),
        } : null,
      };
    });
    const listingSummary = listingsById.get(String(doc._id)) || { total: 0, active: 0, errors: 0 };
    const inventory = inventoryByProductId.get(String(doc._id)) || null;
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const onHand = Math.max(0, Math.floor(Number(inventory?.onHand || 0)));
    const result = {
      id: String(doc._id),
      sku: plain.sku || '',
      ean: plain.ean || '',
      identifiers: normalizeIdentifiers(plain.identifiers, plain.ean),
      name: plain.name || '',
      description: plain.description || '',
      brand: plain.brand || '',
      language: plain.language || 'pl-PL',
      condition: plain.condition || 'unknown',
      categoryId: plain.categoryId ? String(plain.categoryId) : '',
      category: plain.categoryId && categoryById.get(String(plain.categoryId)) ? {
        id: String(categoryById.get(String(plain.categoryId))._id),
        name: categoryById.get(String(plain.categoryId)).name || '',
        slug: categoryById.get(String(plain.categoryId)).slug || '',
        parentId: categoryById.get(String(plain.categoryId)).parentId ? String(categoryById.get(String(plain.categoryId)).parentId) : '',
        status: categoryById.get(String(plain.categoryId)).status || 'active',
      } : null,
      basePrice: Number(plain.basePrice || 0),
      currency: plain.currency || 'PLN',
      media: normalizeProductMedia(plain.media, plain.name),
      attributes: plain.attributes && typeof plain.attributes === 'object' ? plain.attributes : {},
      attributeValues: normalizeAttributeValues(plain.attributeValues),
      physical: normalizePhysical(plain.physical || {}),
      status: plain.status || 'draft',
      source: plain.source || 'manual',
      warehouseBindings: bindings,
      // Backward-compatible field consumed by publication/preflight code. It is
      // now strictly the independent internet-store inventory quantity.
      availableStock: onHand,
      commerceInventory: {
        onHand,
        status: inventory?.status || 'active',
        source: inventory?.source || 'manual',
        sourceWarehouseProductId: inventory?.sourceWarehouseProductId ? String(inventory.sourceWarehouseProductId) : '',
        sourceSnapshotAt: inventory?.sourceSnapshotAt || null,
        updatedAt: inventory?.updatedAt || null,
      },
      listingSummary: {
        total: Number(listingSummary.total || 0),
        active: Number(listingSummary.active || 0),
        errors: Number(listingSummary.errors || 0),
      },
      createdAt: plain.createdAt || null,
      updatedAt: plain.updatedAt || null,
    };
    result.masterReadiness = computeProductMasterReadiness(result);
    return result;
  });
}


async function listCatalog(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize, 10) || 24));
  const status = text(query.status || 'all', 30).toLowerCase();
  const search = text(query.search, 200);
  const filter = {};
  if (status !== 'all') {
    if (!VALID_STATUSES.has(status)) throw appError('validation_failed', { field: 'status' });
    filter.status = status;
  }
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { brand: rx }, { sku: rx }, { ean: rx }, { 'identifiers.value': rx }];
  }

  const [rows, total] = await Promise.all([
    CommerceProduct.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    CommerceProduct.countDocuments(filter),
  ]);

  return {
    items: await hydrateProducts(rows),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function getCatalogProduct(id) {
  if (!mongoose.isValidObjectId(id)) throw appError('commerce_product_not_found');
  const product = await CommerceProduct.findById(id).lean();
  if (!product) throw appError('commerce_product_not_found');
  const [hydrated] = await hydrateProducts([product]);
  return hydrated;
}

async function createCatalogProduct(raw, req) {
  const actor = actorFromRequest(req);
  const payload = await normalizePayload(raw || {}, { partial: false });
  const inventoryQuantity = normalizeInventoryQuantity(raw?.inventoryQuantity ?? 0);
  await assertWarehouseBindingsExist(payload.warehouseBindings);
  const doc = new CommerceProduct({
    ...payload,
    source: 'manual',
    createdByTelegramId: actor.telegramId,
    createdByName: actor.name,
    updatedByTelegramId: actor.telegramId,
    updatedByName: actor.name,
  });
  try {
    await doc.save();
    await CommerceInventoryItem.findOneAndUpdate(
      { commerceProductId: doc._id },
      {
        $setOnInsert: {
          commerceProductId: doc._id,
          onHand: inventoryQuantity,
          status: 'active',
          source: 'manual',
          createdByTelegramId: actor.telegramId,
          createdByName: actor.name,
        },
        $set: { updatedByTelegramId: actor.telegramId, updatedByName: actor.name },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.skuKey) throw appError('commerce_product_sku_duplicate');
    throw err;
  }
  return getCatalogProduct(doc._id);
}

async function updateCatalogProduct(id, raw, req) {
  if (!mongoose.isValidObjectId(id)) throw appError('commerce_product_not_found');
  const doc = await CommerceProduct.findById(id);
  if (!doc) throw appError('commerce_product_not_found');
  const patch = await normalizePayload(raw || {}, { partial: true, current: doc.toObject() });
  const inventoryQuantity = raw?.inventoryQuantity !== undefined ? normalizeInventoryQuantity(raw.inventoryQuantity) : null;
  if (patch.warehouseBindings) await assertWarehouseBindingsExist(patch.warehouseBindings);
  Object.assign(doc, patch);
  const actor = actorFromRequest(req);
  doc.updatedByTelegramId = actor.telegramId;
  doc.updatedByName = actor.name;
  try {
    await doc.save();
    if (inventoryQuantity !== null) {
      await CommerceInventoryItem.findOneAndUpdate(
        { commerceProductId: doc._id },
        {
          $set: {
            onHand: inventoryQuantity,
            status: 'active',
            updatedByTelegramId: actor.telegramId,
            updatedByName: actor.name,
          },
          $setOnInsert: {
            commerceProductId: doc._id,
            source: 'manual',
            createdByTelegramId: actor.telegramId,
            createdByName: actor.name,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.skuKey) throw appError('commerce_product_sku_duplicate');
    throw err;
  }
  return getCatalogProduct(doc._id);
}


async function getCatalogProductsByIds(ids = []) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter((id) => mongoose.isValidObjectId(id)))];
  if (!normalized.length) return [];
  const rows = await CommerceProduct.find({ _id: { $in: normalized } }).lean();
  const hydrated = await hydrateProducts(rows);
  const byId = new Map(hydrated.map((item) => [String(item.id), item]));
  return normalized.map((id) => byId.get(id)).filter(Boolean);
}

async function listWarehouseProducts(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(query.pageSize, 10) || 20));
  const search = text(query.search, 200);
  const filter = { status: 'active' };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const maybeOrderNumber = Number(search);
    filter.$or = [
      { name: rx },
      { brand: rx },
      { barcode: rx },
      ...(Number.isInteger(maybeOrderNumber) && maybeOrderNumber > 0 ? [{ orderNumber: maybeOrderNumber }] : []),
    ];
  }

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .select('_id name brand barcode price quantity quantityPerPackage orderNumber status warehouse originalImageUrl localImageUrl imageUrls')
      .sort({ orderNumber: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Product.countDocuments(filter),
  ]);
  const ids = rows.map((row) => row._id);
  const existing = ids.length
    ? await CommerceProduct.find({ 'warehouseBindings.productId': { $in: ids } })
      .select('_id name warehouseBindings.productId')
      .lean()
    : [];
  const linkedByWarehouseId = new Map();
  for (const commerceProduct of existing) {
    for (const binding of commerceProduct.warehouseBindings || []) {
      const key = String(binding.productId || '');
      if (ids.some((id) => String(id) === key) && !linkedByWarehouseId.has(key)) {
        linkedByWarehouseId.set(key, { id: String(commerceProduct._id), name: commerceProduct.name || '' });
      }
    }
  }

  return {
    items: rows.map((row) => ({
      id: String(row._id),
      name: row.name || '',
      brand: row.brand || '',
      barcode: row.barcode || '',
      price: Number(row.price || 0),
      quantity: Number(row.quantity || 0),
      quantityPerPackage: Number(row.quantityPerPackage || 0),
      orderNumber: row.orderNumber ?? null,
      status: row.status || '',
      warehouse: row.warehouse || '',
      imageUrl: bestWarehouseImage(row),
      linkedCommerceProduct: linkedByWarehouseId.get(String(row._id)) || null,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function importWarehouseProducts(raw, req) {
  const rawIds = Array.isArray(raw?.productIds) ? raw.productIds : [];
  const ids = [...new Set(rawIds.map((id) => String(id || '').trim()))]
    .filter((id) => mongoose.isValidObjectId(id))
    .slice(0, MAX_IMPORT_BATCH);
  if (!ids.length) throw appError('commerce_warehouse_products_required');

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const [warehouseProducts, existingLinks] = await Promise.all([
    Product.find({ _id: { $in: objectIds }, status: 'active' })
      .select('_id name brand barcode price quantity orderNumber status originalImageUrl localImageUrl imageUrls')
      .lean(),
    CommerceProduct.find({
      $or: [
        { directWarehouseProductId: { $in: objectIds } },
        { 'warehouseBindings.productId': { $in: objectIds } },
      ],
    })
      .select('+directWarehouseProductId _id name warehouseBindings.productId')
      .lean(),
  ]);
  const warehouseById = new Map(warehouseProducts.map((row) => [String(row._id), row]));
  const existingByWarehouseId = new Map();
  for (const commerceProduct of existingLinks) {
    const directKey = String(commerceProduct.directWarehouseProductId || '');
    if (ids.includes(directKey) && !existingByWarehouseId.has(directKey)) {
      existingByWarehouseId.set(directKey, { id: String(commerceProduct._id), name: commerceProduct.name || '' });
    }
    for (const binding of commerceProduct.warehouseBindings || []) {
      const key = String(binding.productId || '');
      if (ids.includes(key) && !existingByWarehouseId.has(key)) {
        existingByWarehouseId.set(key, { id: String(commerceProduct._id), name: commerceProduct.name || '' });
      }
    }
  }

  const actor = actorFromRequest(req);
  const created = [];
  const skipped = [];
  for (const id of ids) {
    const existing = existingByWarehouseId.get(id);
    if (existing) {
      skipped.push({ productId: id, reason: 'already_linked', commerceProduct: existing });
      continue;
    }
    const product = warehouseById.get(id);
    if (!product) {
      skipped.push({ productId: id, reason: 'warehouse_product_not_found_or_inactive' });
      continue;
    }
    const imageUrl = bestWarehouseImage(product);
    const doc = new CommerceProduct({
      name: text(product.name, 500) || `Товар #${product.orderNumber || ''}`.trim(),
      brand: text(product.brand, 300),
      ean: text(product.barcode, 120),
      identifiers: normalizeIdentifiers([], text(product.barcode, 120)).map((item) => ({ ...item, source: 'warehouse' })),
      basePrice: Math.max(0, Number(product.price || 0)),
      currency: 'PLN',
      media: imageUrl ? [{ type: 'image', url: imageUrl, alt: text(product.name, 300), source: 'warehouse', role: 'primary', position: 0 }] : [],
      warehouseBindings: [{ productId: product._id, unitsPerItem: 1, stockBuffer: 0, enabled: true }],
      directWarehouseProductId: product._id,
      status: 'draft',
      source: 'warehouse_import',
      createdByTelegramId: actor.telegramId,
      createdByName: actor.name,
      updatedByTelegramId: actor.telegramId,
      updatedByName: actor.name,
    });
    try {
      await doc.save();
      await CommerceInventoryItem.findOneAndUpdate(
        { commerceProductId: doc._id },
        {
          $setOnInsert: {
            commerceProductId: doc._id,
            // Copying a position from the main warehouse copies catalog data only.
            // Internet-store stock starts independently and is never live-linked
            // to Product.quantity.
            onHand: 0,
            status: 'active',
            source: 'warehouse_copy',
            sourceWarehouseProductId: product._id,
            sourceSnapshotAt: new Date(),
            createdByTelegramId: actor.telegramId,
            createdByName: actor.name,
          },
          $set: { updatedByTelegramId: actor.telegramId, updatedByName: actor.name },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      created.push(String(doc._id));
      existingByWarehouseId.set(id, { id: String(doc._id), name: doc.name });
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.directWarehouseProductId) {
        const raced = await CommerceProduct.findOne({ directWarehouseProductId: product._id }).select('_id name').lean();
        skipped.push({
          productId: id,
          reason: 'already_linked',
          commerceProduct: raced ? { id: String(raced._id), name: raced.name || '' } : null,
        });
        continue;
      }
      if (err?.code === 11000 && err?.keyPattern?.skuKey) throw appError('commerce_product_sku_duplicate');
      throw err;
    }
  }

  const createdDocs = created.length
    ? await CommerceProduct.find({ _id: { $in: created } }).sort({ createdAt: -1 }).lean()
    : [];
  return {
    created: await hydrateProducts(createdDocs),
    createdCount: created.length,
    skippedCount: skipped.length,
    skipped,
  };
}

module.exports = {
  listCatalog,
  getCatalogProduct,
  createCatalogProduct,
  updateCatalogProduct,
  listWarehouseProducts,
  importWarehouseProducts,
  getCatalogProductsByIds,
};
