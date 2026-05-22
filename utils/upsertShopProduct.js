'use strict';

const ShopProduct = require('../models/ShopProduct');
const { embedShopProductAsync } = require('./shopProductEmbedding');

// Upsert a ShopProduct ("Товари Магазинів") from a warehouse Product. Used when a
// product goes active (products route) and when a receipt item is confirmed.
// $setOnInsert means manually-edited shop catalog data is never overwritten;
// only the linkedProductId is kept in sync. A freshly-created entry with a photo
// is auto-indexed for vector search in the background.
async function upsertShopProductFromProduct(product) {
  if (!product?._id) return null;
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
    linkedProductId:    product._id,
    barcode,
  };
  const doc = await ShopProduct.findOneAndUpdate(
    filter,
    { $set: { linkedProductId: product._id }, $setOnInsert: insertData },
    { upsert: true, new: true },
  );
  if (doc && !doc.embedding && (doc.imageUrl || doc.originalImageUrl)) {
    embedShopProductAsync(doc, 'upsert-from-product');
  }
  return doc;
}

module.exports = { upsertShopProductFromProduct };
