'use strict';

const mongoose = require('mongoose');
const CommerceProduct = require('../../models/CommerceProduct');
const ChannelListing = require('../../models/ChannelListing');
const Product = require('../../models/Product');
const { appError } = require('../../utils/errors');

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

function normalizeMedia(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const media = [];
  for (const item of raw.slice(0, 30)) {
    const url = text(typeof item === 'string' ? item : item?.url, 2000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    media.push({
      type: 'image',
      url,
      alt: text(item?.alt, 300),
      source: ['catalog', 'warehouse', 'provider'].includes(item?.source) ? item.source : 'catalog',
    });
  }
  return media;
}

function normalizeAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).slice(0, 200));
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

function normalizePayload(raw = {}, { partial = false } = {}) {
  const patch = {};
  const set = (key, value) => { patch[key] = value; };

  if (!partial || raw.name !== undefined) {
    const name = text(raw.name, 500);
    if (!name) throw appError('commerce_product_name_required');
    set('name', name);
  }
  if (!partial || raw.sku !== undefined) set('sku', text(raw.sku, 120));
  if (!partial || raw.ean !== undefined) set('ean', text(raw.ean, 120));
  if (!partial || raw.description !== undefined) set('description', text(raw.description, 20000));
  if (!partial || raw.brand !== undefined) set('brand', text(raw.brand, 300));
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
  if (!partial || raw.media !== undefined) set('media', normalizeMedia(raw.media));
  if (!partial || raw.attributes !== undefined) set('attributes', normalizeAttributes(raw.attributes));
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

function calculateBindingStock(binding, warehouseProduct) {
  if (!binding?.enabled || !warehouseProduct || warehouseProduct.status !== 'active') return 0;
  const quantity = Math.max(0, Number(warehouseProduct.quantity || 0));
  const buffer = Math.max(0, Number(binding.stockBuffer || 0));
  const unitsPerItem = Math.max(0.000001, Number(binding.unitsPerItem || 1));
  return Math.max(0, Math.floor((quantity - buffer) / unitsPerItem));
}

async function hydrateProducts(rawProducts) {
  const docs = Array.isArray(rawProducts) ? rawProducts : [];
  if (!docs.length) return [];

  const productIds = [...new Set(docs.flatMap((doc) => (doc.warehouseBindings || [])
    .map((binding) => String(binding.productId || ''))
    .filter((id) => mongoose.isValidObjectId(id))))];
  const commerceIds = docs.map((doc) => doc._id);

  const [warehouseRows, listingRows] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds } })
        .select('_id name orderNumber barcode quantity status warehouse originalImageUrl localImageUrl imageUrls')
        .lean()
      : [],
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
  ]);

  const warehouseById = new Map(warehouseRows.map((row) => [String(row._id), row]));
  const listingsById = new Map(listingRows.map((row) => [String(row._id), row]));

  return docs.map((doc) => {
    const bindings = (doc.warehouseBindings || []).map((binding) => {
      const bindingObj = typeof binding.toObject === 'function' ? binding.toObject() : binding;
      const warehouseProduct = warehouseById.get(String(bindingObj.productId || '')) || null;
      return {
        productId: String(bindingObj.productId || ''),
        unitsPerItem: Number(bindingObj.unitsPerItem || 1),
        stockBuffer: Number(bindingObj.stockBuffer || 0),
        enabled: bindingObj.enabled !== false,
        availableStock: calculateBindingStock(bindingObj, warehouseProduct),
        warehouseProduct: warehouseProduct ? {
          id: String(warehouseProduct._id),
          name: warehouseProduct.name || '',
          orderNumber: warehouseProduct.orderNumber ?? null,
          barcode: warehouseProduct.barcode || '',
          quantity: Number(warehouseProduct.quantity || 0),
          status: warehouseProduct.status || '',
          warehouse: warehouseProduct.warehouse || '',
          imageUrl: bestWarehouseImage(warehouseProduct),
        } : null,
      };
    });
    const listingSummary = listingsById.get(String(doc._id)) || { total: 0, active: 0, errors: 0 };
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
      id: String(doc._id),
      sku: plain.sku || '',
      ean: plain.ean || '',
      name: plain.name || '',
      description: plain.description || '',
      brand: plain.brand || '',
      basePrice: Number(plain.basePrice || 0),
      currency: plain.currency || 'PLN',
      media: Array.isArray(plain.media) ? plain.media : [],
      attributes: plain.attributes && typeof plain.attributes === 'object' ? plain.attributes : {},
      status: plain.status || 'draft',
      source: plain.source || 'manual',
      warehouseBindings: bindings,
      availableStock: bindings.reduce((sum, binding) => sum + Number(binding.availableStock || 0), 0),
      listingSummary: {
        total: Number(listingSummary.total || 0),
        active: Number(listingSummary.active || 0),
        errors: Number(listingSummary.errors || 0),
      },
      createdAt: plain.createdAt || null,
      updatedAt: plain.updatedAt || null,
    };
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
    filter.$or = [{ name: rx }, { brand: rx }, { sku: rx }, { ean: rx }];
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
  const payload = normalizePayload(raw || {}, { partial: false });
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
  const patch = normalizePayload(raw || {}, { partial: true });
  if (patch.warehouseBindings) await assertWarehouseBindingsExist(patch.warehouseBindings);
  Object.assign(doc, patch);
  const actor = actorFromRequest(req);
  doc.updatedByTelegramId = actor.telegramId;
  doc.updatedByName = actor.name;
  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.skuKey) throw appError('commerce_product_sku_duplicate');
    throw err;
  }
  return getCatalogProduct(doc._id);
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
      basePrice: Math.max(0, Number(product.price || 0)),
      currency: 'PLN',
      media: imageUrl ? [{ type: 'image', url: imageUrl, alt: text(product.name, 300), source: 'warehouse' }] : [],
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
};
