'use strict';

const ShopProduct = require('../models/ShopProduct');

// Актуальна процедура відновлення: docs/operations/maintenance-mode.md
async function ensureShopProductIndexes() {
  const coll = ShopProduct.collection;
  const indexes = await coll.indexes();
  const barcodeIdx = indexes.find((index) => index.name === 'barcode_1');

  if (barcodeIdx && !barcodeIdx.partialFilterExpression) {
    console.log('[indexes] dropping stale ShopProduct.barcode_1');
    await coll.dropIndex('barcode_1');
  }

  await coll.createIndex(
    { barcode: 1 },
    { unique: true, partialFilterExpression: { barcode: { $gt: '' } }, name: 'barcode_1' },
  );
}

module.exports = { ensureShopProductIndexes };
