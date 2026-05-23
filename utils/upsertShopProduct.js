'use strict';

const ShopProduct = require('../models/ShopProduct');
const { embedShopProductAsync } = require('./shopProductEmbedding');

// Upsert a ShopProduct ("Товари Магазинів") from a warehouse Product. Used when a
// product goes active (products route) and when a receipt item is confirmed.
// $setOnInsert means manually-edited shop catalog data is never overwritten;
// only the linkedProductId is kept in sync. A freshly-created entry with a photo
// is auto-indexed for vector search in the background.
async function upsertShopProductFromProduct(product) {
  if (!product?._id) { console.warn('[shop-upsert] skipped: no product'); return null; }
  const barcode = String(product.barcode || '').trim();
  const filter = barcode ? { barcode } : { linkedProductId: product._id };
  const insertData = {
    name:               product.name || product.brand || product.model || product.category || '',
    price:              product.price || 0,
    quantityPerPackage: product.quantityPerPackage || 0,
    notes:              product.notes || '',
    originalImageUrl:   product.originalImageUrl || product.imageUrls?.[0] || '',
    imageUrl:           product.imageUrls?.[0] || '',
    labelPositions:     product.labelPositions || {},
    source:             'receive',
    barcode,
    // NOTE: linkedProductId lives ONLY in $set below. Having it in both $set and
    // $setOnInsert triggers MongoDB conflict code 40 and the whole upsert fails.
  };
  try {
    const doc = await ShopProduct.findOneAndUpdate(
      filter,
      { $set: { linkedProductId: product._id }, $setOnInsert: insertData },
      { upsert: true, new: true },
    );
    if (doc && !doc.embedding && (doc.imageUrl || doc.originalImageUrl)) {
      embedShopProductAsync(doc, 'upsert-from-product');
    }
    return doc;
  } catch (err) {
    console.error('[shop-upsert] failed:', err.code, err.message);
    return null;
  }
}

// Push the SHARED (owner-authoritative) fields from a warehouse Product onto its
// linked ShopProduct MIRROR. Unlike `upsertShopProductFromProduct` (which only
// $setOnInsert), this OVERWRITES the mirror's shared fields, because the
// warehouse is the single writer for these. It targets ONLY the
// linkedProductId-matched doc — shop-OWNED ShopProducts (linkedProductId: null)
// are never touched. Local fields (embedding/descriptor/createdBy) are left
// alone. Pure DB write — no image processing; the labeled photo URL is just
// copied across.
//
// `name` is only overwritten when non-empty: a blank computed name is almost
// never an intentional clear and would silently wipe a good mirror name.
async function pushSharedFieldsToMirror(product, { photoChanged = false } = {}) {
  if (!product?._id) return null;
  const imageUrl = product.imageUrls?.[0] || '';
  const computedName = product.name || product.brand || product.model || product.category || '';

  const $set = {
    price:              product.price || 0,
    quantityPerPackage: product.quantityPerPackage || 0,
    notes:              product.notes || '',
    imageUrl,
    originalImageUrl:   product.originalImageUrl || imageUrl || '',
    labelPositions:     product.labelPositions || {},
    barcode:            String(product.barcode || '').trim(),
  };
  if (computedName) $set.name = computedName;

  try {
    const doc = await ShopProduct.findOneAndUpdate(
      { linkedProductId: product._id },
      { $set },
      { new: true },
    );
    // New photo → the mirror's embedding is stale; re-index in the background.
    if (doc && photoChanged && (doc.imageUrl || doc.originalImageUrl)) {
      embedShopProductAsync(doc, 'mirror-push');
    }
    return doc;
  } catch (err) {
    console.error('[shop-mirror-push] failed:', err.code, err.message);
    return null;
  }
}

// Create/refresh the shop-OWNED ShopProduct for a brand-new `destination: 'shops'`
// receipt item (goods that go straight to shops and never touch the warehouse).
// linkedProductId stays NULL → the record is OWNED by the shop catalog (editable
// there), as opposed to a warehouse mirror. Idempotent: matches by
// createdShopProductId, then by barcode (shop-owned only — never hijacks a
// warehouse mirror), else creates. Returns the doc; the caller persists
// item.createdShopProductId. `item` is a plain object (e.g. ReceiptItem.toObject()).
async function upsertShopOwnedFromReceiptItem(item) {
  if (!item?._id) { console.warn('[shop-owned] skipped: no item'); return null; }
  const barcode = String(item.barcode || '').trim();
  const pm = item.photoMeta || {};
  const labelPositions = {};
  if (pm.commentPos) { labelPositions.commentX = pm.commentPos.x; labelPositions.commentY = pm.commentPos.y; }
  if (pm.pricePos)   { labelPositions.priceX   = pm.pricePos.x;   labelPositions.priceY   = pm.pricePos.y; }
  if (pm.qtyPos)     { labelPositions.qtyX     = pm.qtyPos.x;     labelPositions.qtyY     = pm.qtyPos.y; }

  const data = {
    name:               item.name || '',
    price:              item.price || 0,
    quantityPerPackage: item.qtyPerPackage || 0,
    notes:              String(pm.comment || ''),
    originalImageUrl:   item.originalPhotoUrl || item.photoUrl || '',
    imageUrl:           item.photoUrl || '',
    labelPositions,
    source:             'receive',
    barcode,
    // linkedProductId intentionally NOT set → shop-owned (null).
  };

  try {
    // 1. Known doc from a previous confirm → refresh it in place.
    if (item.createdShopProductId) {
      const doc = await ShopProduct.findOneAndUpdate(
        { _id: item.createdShopProductId, linkedProductId: null },
        { $set: data },
        { new: true },
      );
      if (doc) {
        if (doc.imageUrl || doc.originalImageUrl) embedShopProductAsync(doc, 'shop-owned-refresh');
        return doc;
      }
      // else it was deleted/converted — fall through to (re)create.
    }

    // 2. Match an existing shop-OWNED doc by barcode (never a warehouse mirror).
    if (barcode) {
      const existing = await ShopProduct.findOne({ barcode });
      if (existing) {
        // A warehouse mirror already represents this barcode — don't duplicate/hijack.
        if (existing.linkedProductId) return existing;
        const doc = await ShopProduct.findByIdAndUpdate(existing._id, { $set: data }, { new: true });
        if (doc && (doc.imageUrl || doc.originalImageUrl)) embedShopProductAsync(doc, 'shop-owned-refresh');
        return doc;
      }
    }

    // 3. Create fresh.
    const doc = await ShopProduct.create({ ...data, linkedProductId: null });
    if (doc.imageUrl || doc.originalImageUrl) embedShopProductAsync(doc, 'shop-owned-create');
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      console.warn('[shop-owned] barcode already in catalogue, skipped:', barcode);
      return null;
    }
    console.error('[shop-owned] failed:', err.code, err.message);
    return null;
  }
}

module.exports = {
  upsertShopProductFromProduct,
  pushSharedFieldsToMirror,
  upsertShopOwnedFromReceiptItem,
};
