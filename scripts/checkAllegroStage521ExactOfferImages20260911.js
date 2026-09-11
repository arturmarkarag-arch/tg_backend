'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const orders = read('services/allegroOrders.js');
const fallback = read('services/allegroCatalogImageResolver.js');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

check('Allegro order photos prefer exact seller offer primaryImage', () => {
  assert(orders.includes("path: '/sale/offers'"));
  assert(orders.includes("query: { 'offer.id': id, limit: 1 }"));
  assert(orders.includes('offer?.primaryImage'));
  assert(orders.includes("source: 'sale_offers_primary_image'"));
});

check('Allegro order photos fall back through full offer and exact catalog product', () => {
  assert(orders.includes('/sale/product-offers/${encodeURIComponent(id)}'));
  assert(orders.includes('/sale/products/${encodeURIComponent(productId)}'));
  assert(orders.includes("source: 'catalog_product'"));
});

check('photo backfill returns actionable diagnostics', () => {
  assert(orders.includes('resolvedOffers: imageMap.size'));
  assert(orders.includes('unresolvedOfferIds: unresolvedOfferIds.slice(0, 20)'));
  assert(orders.includes("requiredScope: 'allegro:api:sale:offers:read'"));
});

check('BaseLinker exact Allegro fallback also uses seller offer primaryImage first', () => {
  assert(fallback.includes("path: '/sale/offers'"));
  assert(fallback.includes("query: { 'offer.id': offerId, limit: 1 }"));
  assert(fallback.includes('offer?.primaryImage'));
  assert(fallback.includes("source: 'allegro_offer_primary'"));
});

console.log(`\nAllegro Stage 5.2.1 exact offer images: ${pass}/${pass} PASS`);
