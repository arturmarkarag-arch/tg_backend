'use strict';

const ShopProduct = require('../models/ShopProduct');

// Make sure the ShopProduct.barcode unique index is the PARTIAL one (unique only
// for non-empty barcodes). An older `barcode_1` index (plain/sparse unique, no
// partialFilterExpression) silently rejects a 2nd empty-barcode doc with E11000.
// That was blocking receipt-confirmed products (which often have no barcode) from
// landing in "Товари Магазинів" — the upsert threw and was swallowed.
//
// Mongoose can't replace a same-named index with different options on its own, so
// we drop the mismatched one here and (re)create the correct partial index.
async function ensureShopProductIndexes() {
  try {
    const coll = ShopProduct.collection;
    const indexes = await coll.indexes();
    const barcodeIdx = indexes.find((i) => i.name === 'barcode_1');
    console.log('[migrate] ShopProduct barcode_1 index before:', barcodeIdx ? JSON.stringify(barcodeIdx) : 'none');

    if (barcodeIdx && !barcodeIdx.partialFilterExpression) {
      console.log('[migrate] dropping stale (non-partial) barcode_1 index');
      await coll.dropIndex('barcode_1');
    }

    await coll.createIndex(
      { barcode: 1 },
      { unique: true, partialFilterExpression: { barcode: { $gt: '' } }, name: 'barcode_1' },
    );
    console.log('[migrate] ShopProduct barcode_1 partial unique index ensured ✓');
  } catch (err) {
    console.error('[migrate] ensureShopProductIndexes failed:', err.message);
  }
}

module.exports = { ensureShopProductIndexes };
