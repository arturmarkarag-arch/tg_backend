'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('seller ordinary catalogue source contract', () => {
  const routes = read('routes/products.js');
  const base = sliceBetweenOrThrow(
    routes,
    'async function getSellerCatalogBasePipeline(req)',
    "router.get('/catalog'",
    { label: 'seller catalog eligibility pipeline' },
  );
  const page = sliceBetweenOrThrow(
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

  test('keeps every current seller eligibility rule', () => {
    expect(base).toContain("status: 'active'");
    expect(base).toContain('orderingEnabled: { $ne: false }');
    expect(base).toContain("'_block.0': { $exists: true }");
    expect(base).toContain('applySellerCycleCutoff(match, context.cutoff)');
    expect(base).toContain('getSupplementExcludedProductIds(context.orderingSessionId)');
    expect(base).toContain('match._id = { $nin: supplementProductIds }');
  });

  test('sorts and pages in Mongo without vector ordering or a global id array', () => {
    expect(routes).toContain('const SELLER_CATALOG_SORT = Object.freeze({ orderNumber: 1, createdAt: -1, _id: 1 });');
    expect(page).toContain('{ $sort: SELLER_CATALOG_SORT }');
    expect(page).toContain('{ $skip: offset }');
    expect(page).toContain('{ $limit: limit }');
    expect(page).not.toContain('ids.slice(');
    expect(routes).not.toContain('getSellerVisualOrder');
    expect(routes).not.toContain('seller_visual_catalog');
    expect(routes).not.toContain('seller-visual:');
  });

  test('position uses the identical ordinary comparator and Mongo counts', () => {
    expect(position).toContain('const beforeMatch = {');
    expect(position).toContain('{ orderNumber: { $lt: targetOrderNumber } }');
    expect(position).toContain('{ orderNumber: targetOrderNumber, createdAt: { $gt: target.createdAt } }');
    expect(position).toContain("{ $count: 'count' }");
    expect(position).not.toContain('.indexOf(');
  });
});
