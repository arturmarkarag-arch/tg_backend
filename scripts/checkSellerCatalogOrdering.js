'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('../tests/helpers/sourceContract');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS: ${message}`);
}

const routes = read('routes/products.js');
const productModel = read('models/Product.js');
const base = sliceBetweenOrThrow(
  routes,
  'async function getSellerCatalogBasePipeline(req)',
  "router.get('/catalog'",
  { label: 'seller catalog eligibility pipeline' },
);
const catalog = sliceBetweenOrThrow(
  routes,
  "router.get('/catalog'",
  "router.get('/catalog/:id/position'",
  { label: 'seller catalog page route' },
);
const position = sliceBetweenOrThrow(
  routes,
  "router.get('/catalog/:id/position'",
  '// Legacy orderNumber-position resolver',
  { label: 'seller catalog position route' },
);

assert(routes.includes('const SELLER_CATALOG_SORT = Object.freeze({ orderNumber: 1 });'), 'seller order is stable and deterministic');
assert(productModel.includes('{ orderNumber: 1 }') && productModel.includes('unique: true') && productModel.includes("status: { $in: ['pending', 'active'] }"), 'orderNumber is DB-unique for live Products');
assert(base.includes("status: 'active'"), 'seller catalogue requires active warehouse status');
assert(base.includes('orderingEnabled: { $ne: false }'), 'ordinary-order gate is preserved');
assert(base.includes("'_block.0': { $exists: true }"), 'real Block membership is required');
assert(base.includes('applySellerCycleCutoff(match, context.cutoff)'), 'seller-cycle cutoff is preserved');
assert(base.includes('getSupplementExcludedProductIds(context.orderingSessionId)'), 'same-session SupplementWave exclusion is preserved');
assert(base.includes('match._id = { $nin: supplementProductIds }'), 'supplement product ids are excluded in Mongo');

assert(catalog.includes("Product.aggregate([...basePipeline, { $count: 'total' }])"), 'catalogue total is counted in Mongo');
assert(catalog.includes('{ $sort: SELLER_CATALOG_SORT }'), 'catalogue page is sorted in Mongo');
assert(catalog.includes('{ $skip: offset }'), 'catalogue offset is applied in Mongo');
assert(catalog.includes('{ $limit: limit }'), 'catalogue limit is applied in Mongo');
assert(routes.includes('function parseCatalogPageInteger(value, fallback, min, max)'), 'Mongo pagination values are normalized to bounded integers');
assert(!catalog.includes('ids.slice('), 'catalogue never pages an all-products id array in Node');

assert(position.includes('const beforeMatch = {'), 'position resolver uses the ordinary-order comparator');
assert(position.includes("const beforeMatch = { orderNumber: { $lt: target.orderNumber } };"), 'position resolver counts lower order numbers only');
assert(position.includes("{ $count: 'count' }"), 'position and total are counted in Mongo');
assert(!position.includes('.indexOf('), 'position resolver never builds and scans a global id sequence');
assert(!routes.includes('try { orderingSessionId = await findCurrentSessionId'), 'session lookup fails closed instead of disabling supplement exclusion');

for (const token of ['getSellerVisualOrder', 'sellerVisualOrdering', 'seller_visual_catalog', 'seller-visual:']) {
  assert(!routes.includes(token), `products route has no retired vector-order token: ${token}`);
}
for (const rel of [
  'services/sellerVisualOrdering.js',
  'services/sellerVisualOrderingAlgo.js',
  'tests/sellerVisualOrderingAlgo.test.js',
  'scripts/checkSellerVisualOrderingV48_1.js',
]) {
  assert(!fs.existsSync(path.join(root, rel)), `retired vector-order file is absent: ${rel}`);
}

console.log('Seller ordinary catalogue ordering checks complete.');
