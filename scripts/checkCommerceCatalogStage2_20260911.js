'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };

const product = read('models/CommerceProduct.js');
const listing = read('models/ChannelListing.js');
const service = read('services/commerce/catalog.js');
const route = read('routes/commerce.js');
const docs = read('docs/architecture/commerce-catalog.md');

check('CommerceProduct is provider-neutral and does not own a duplicated quantity field', () => {
  assert(product.includes("module.exports = mongoose.model('CommerceProduct'"));
  assert(product.includes('warehouseBindings'));
  assert(!/\n\s*quantity:\s*\{/.test(product));
  assert(!product.includes('allegroOfferId'));
  assert(!product.includes('olx'));
  assert(!product.includes('temu'));
});

check('warehouse import has a durable concurrency-safe idempotency anchor', () => {
  assert(product.includes('directWarehouseProductId'));
  assert(product.includes("partialFilterExpression: { directWarehouseProductId: { $type: 'objectId' } }"));
  assert(service.includes("reason: 'already_linked'"));
  assert(service.includes('keyPattern?.directWarehouseProductId'));
});

check('available stock is derived from authoritative warehouse Product rows', () => {
  assert(service.includes("Product.find({ _id: { $in: productIds } })"));
  assert(service.includes('calculateBindingStock'));
  assert(service.includes('warehouseProduct.status !== \'active\''));
  assert(service.includes('Math.floor((quantity - buffer) / unitsPerItem)'));
});

check('catalog rejects dangling warehouse binding ids instead of persisting broken references', () => {
  assert(service.includes('async function assertWarehouseBindingsExist'));
  assert(service.includes("throw appError('commerce_warehouse_product_not_found')"));
  assert(service.includes('await assertWarehouseBindingsExist(payload.warehouseBindings)'));
  assert(service.includes('if (patch.warehouseBindings) await assertWarehouseBindingsExist(patch.warehouseBindings)'));
});

check('ChannelListing is a separate provider/account-specific publication binding', () => {
  assert(listing.includes('commerceProductId'));
  assert(listing.includes('provider'));
  assert(listing.includes('accountId'));
  assert(listing.includes('externalId'));
  assert(listing.includes('syncState'));
  assert(listing.includes("mode: { type: String, enum: ['inherit', 'fixed', 'capped']"));
});

check('catalog API exposes list/create/update and warehouse import without publishing', () => {
  for (const endpoint of [
    "router.get('/catalog'",
    "router.post('/catalog'",
    "router.get('/catalog/warehouse-products'",
    "router.post('/catalog/import-warehouse'",
    "router.get('/catalog/:id'",
    "router.patch('/catalog/:id'",
  ]) assert(route.includes(endpoint), endpoint);
  assert(!route.includes('/publish'));
});

check('catalog API stays inside marketplace worker authorization boundary', () => {
  assert(route.includes('router.use(requireMarketplaceWarehouseAccess)'));
});

check('architecture contract records stock authority and Stage 3 non-goals', () => {
  assert(docs.includes('`Product` remains the authority for physical warehouse quantity'));
  assert(docs.includes('no outbound publishing'));
  assert(docs.includes('not** a bundle/BOM model'));
});

console.log(`\n${passed}/${passed} Commerce Catalog Stage 2 backend contract checks passed`);
