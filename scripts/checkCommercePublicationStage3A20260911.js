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

const oauth = read('services/allegroOAuth.js');
const caps = read('services/allegroCapabilities.js');
const route = read('routes/commerce.js');
const preview = read('services/commerce/publicationPreview.js');
const listing = read('models/ChannelListing.js');
const registry = read('services/commerce/integrationRegistry.js');

check('OAuth requests sale:offers:write', () => assert(oauth.includes("'allegro:api:sale:offers:write'"), 'write scope missing from OAuth defaults'));
check('capability matrix exposes saleOffersWrite', () => assert(caps.includes('saleOffersWrite'), 'saleOffersWrite capability missing'));
check('preview endpoint exists', () => assert(route.includes("router.post('/publications/preview'"), 'preview route missing'));
check('preview performs zero upstream calls', () => {
  assert(preview.includes('providerCalls: 0'), 'providerCalls marker missing');
  assert(!preview.includes("'/sale/product-offers'"), 'preview must not call create offer');
  assert(!preview.includes('allegroRequest('), 'preview must not call Allegro HTTP client');
});
check('preflight validates write scope', () => assert(preview.includes('missing_sale_offers_write_scope'), 'write scope validation missing'));
check('preflight validates product essentials', () => {
  for (const token of ['title_invalid', 'price_required', 'stock_required', 'gtin_invalid', 'category_mapping_required']) {
    assert(preview.includes(token), `${token} missing`);
  }
});
check('ChannelListing has durable unique identity', () => {
  assert(listing.includes('identityKey'), 'identityKey missing');
  assert(listing.includes('{ identityKey: 1 }'), 'identityKey index missing');
  assert(listing.includes('partialFilterExpression'), 'partial unique index missing');
});
check('registry shows live preflight and planned publish', () => {
  assert(registry.includes("id: 'offers.preflight'"), 'offers.preflight missing');
  assert(registry.includes("id: 'offers.publish'"), 'offers.publish missing');
  assert(registry.includes("POST /sale/product-offers"), 'create offer endpoint not documented');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3A: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
