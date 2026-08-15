'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const socket = read('socket.js');
const products = read('routes/products.js');
const shopProducts = read('routes/shopProducts.js');
const safePatch = read('utils/catalogueSocket.js');
const { buildWarehouseStockEstimate } = require('../utils/warehouseStockEstimate');

assert(socket.includes("socket.join('staff')"));
assert(products.includes("io.to('staff').emit('catalogue_cache_patch'"));
assert(shopProducts.includes("io.to('staff').emit('catalogue_cache_patch'"));
// Rich product fields must stay in the authenticated staff room, not in the
// global seller-visible catalogue_updated signal.
assert(!/io\.emit\('catalogue_updated'[^\n]*patch:/.test(products));
assert(!/io\.emit\('catalogue_updated'[^\n]*patch:/.test(shopProducts));
assert(safePatch.includes('quantityPerPackage'));
assert(safePatch.includes('aiDescription'));
assert(!safePatch.includes('mandatoryDistribution'));
assert(!safePatch.includes('receiptItemId'));

const legacy = buildWarehouseStockEstimate({
  receivedQty: null,
  regularOrderedPackages: 7,
  supplementOrderedPackages: 2,
  quantityPerPackage: 50,
});
assert.equal(legacy.receivedQty, null);
assert.equal(legacy.estimatedRemaining, null);

console.log('V47.6 server query/socket checks: PASS');
