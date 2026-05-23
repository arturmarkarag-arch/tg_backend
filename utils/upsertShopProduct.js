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
  console.log('[shop-upsert] start', { productId: String(product._id), barcode: barcode || '(empty)', name: insertData.name, filter });
  try {
    const before = await ShopProduct.findOne(filter).select('_id').lean();
    const doc = await ShopProduct.findOneAndUpdate(
      filter,
      { $set: { linkedProductId: product._id }, $setOnInsert: insertData },
      { upsert: true, new: true },
    );
    console.log('[shop-upsert] OK', { shopProductId: String(doc?._id), created: !before, hasPhoto: Boolean(doc?.imageUrl || doc?.originalImageUrl) });
    if (doc && !doc.embedding && (doc.imageUrl || doc.originalImageUrl)) {
      embedShopProductAsync(doc, 'upsert-from-product');
    }
    return doc;
  } catch (err) {
    console.error('[shop-upsert] FAILED', { code: err.code, message: err.message, filter });
    return null;
  }
}

module.exports = { upsertShopProductFromProduct };
