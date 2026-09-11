'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) {
  try { fn(); checks.push([name, true]); }
  catch (err) { checks.push([name, false, err.message]); }
}
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const mapping = read('services/commerce/allegroMapping.js');
const preview = read('services/commerce/publicationPreview.js');
const registry = read('services/commerce/integrationRegistry.js');
const listing = read('models/ChannelListing.js');

check('mapping resolve/save endpoints exist', () => {
  assert(route.includes("router.post('/publications/allegro/mapping/resolve'"), 'resolve endpoint missing');
  assert(route.includes("router.put('/publications/allegro/mapping'"), 'save endpoint missing');
});
check('GTIN search uses current Allegro contract', () => {
  assert(mapping.includes("path: '/sale/products'"), 'GET /sale/products missing');
  assert(mapping.includes("mode: 'GTIN'"), 'GTIN mode missing');
  assert(mapping.includes('phrase:'), 'phrase query missing');
});
check('category suggestions and parameter metadata are read upstream', () => {
  assert(mapping.includes("path: '/sale/matching-categories'"), 'matching-categories missing');
  assert(mapping.includes("/sale/categories/${encodeURIComponent(id)}"), 'category detail missing');
  assert(mapping.includes("/parameters`"), 'category parameters missing');
  assert(mapping.includes("limit: 5, windowMs: 1000"), 'documented matching-categories 5 rps guard missing');
});
check('Stage 3B performs zero Allegro write calls', () => {
  assert(mapping.includes('providerWriteCalls: 0'), 'zero-write marker missing');
  assert(!mapping.includes("method: 'POST'"), 'mapping service must not POST to Allegro');
  assert(!mapping.includes("method: 'PATCH'"), 'mapping service must not PATCH Allegro');
  assert(!mapping.includes("'/sale/product-offers'"), 'product-offers create must not exist in Stage 3B');
});
check('mapping persists in ChannelListing only', () => {
  assert(mapping.includes('ChannelListing.findOne'), 'ChannelListing lookup missing');
  assert(mapping.includes('productParameters'), 'product parameter mapping missing');
  assert(mapping.includes('offerParameters'), 'offer parameter mapping missing');
  assert(mapping.includes('providerData'), 'provider mapping metadata missing');
  assert(mapping.includes("mappingState: 'incomplete'"), 'durable mapping state missing');
  assert(listing.includes('providerData'), 'ChannelListing providerData missing');
});
check('preflight consumes durable ready mapping', () => {
  assert(preview.includes("allegroMapping.mappingState === 'ready'"), 'ready mapping not consumed');
  assert(preview.includes('catalogProductId'), 'catalog product mapping not exposed');
  assert(preview.includes('categoryId'), 'category mapping not exposed');
});
check('registry marks catalog mapping live while publish stays planned', () => {
  assert(registry.includes("id: 'catalog.products.search'"), 'catalog search registry entry missing');
  assert(registry.match(/id: 'catalog\.mapping'[\s\S]*implementation: LIVE/), 'catalog mapping not live');
  assert(registry.match(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/), 'offer publish must remain planned');
});
check('mapping requires read scope and never exposes credentials', () => {
  assert(mapping.includes('commerce_allegro_mapping_scope_required'), 'sale offers read scope guard missing');
  assert(!mapping.includes('tokenEncrypted'), 'encrypted token must not be exposed');
  assert(!mapping.includes('refreshToken'), 'refresh token must not be exposed');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3B backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
