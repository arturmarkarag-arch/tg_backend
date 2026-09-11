'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const policy = require('../services/allegroCatalogImagePolicy');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check('Allegro scheduler defaults to an aggressive five-second poll', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'allegroOrderScheduler.js'), 'utf8');
  assert.match(source, /Number\(process\.env\.ALLEGRO_ORDER_POLL_MS\) \|\| 5_000/);
});

check('title matching accepts exact names', () => {
  assert.strictEqual(policy.scoreProductName('Samsung Galaxy S24 128 GB Black', 'Samsung Galaxy S24 128 GB Black'), 1);
});

check('title matching rejects an unrelated product', () => {
  assert.ok(policy.scoreProductName('Samsung Galaxy S24 128 GB Black', 'Apple iPhone 15 Pro 256 GB Blue') < policy.TITLE_MATCH_THRESHOLD);
});

check('catalog selector does not blindly take a weak first result', () => {
  const selected = policy.selectBestCatalogProduct({ products: [
    { name: 'Unrelated phone case', images: [{ url: 'https://img.example/bad.jpg' }] },
    { name: 'Samsung Galaxy S24 128 GB Black', images: [{ url: 'https://img.example/good.jpg' }] },
  ] }, 'Samsung Galaxy S24 128 GB Black');
  assert.ok(selected);
  assert.strictEqual(selected.images[0], 'https://img.example/good.jpg');
});

check('BaseLinker resolver calls Allegro only as a missing-image fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'baseLinkerProducts.js'), 'utf8');
  assert.match(source, /if \(!staleKeys\.has\(ref\.key\) \|\| ref\.hasDirectImage\) return false;/);
  assert.match(source, /normalizeImageUrls\(entry\?\.images\)\.length === 0/);
  assert.match(source, /resolveBaseLinkerMissingImages/);
});

check('BaseLinker image resolver version was bumped so old negatives are retried', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'baseLinkerProducts.js'), 'utf8');
  assert.match(source, /const IMAGE_RESOLVER_VERSION = 9;/);
});

check('Allegro fallback uses offer, GTIN and title without coupling providers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'allegroCatalogImageResolver.js'), 'utf8');
  assert.match(source, /readers\.length === 1/);
  assert.match(source, /baselinker_missing_image_offer_fallback/);
  assert.match(source, /mode: 'GTIN'/);
  assert.match(source, /baselinker_missing_image_title_fallback/);
  assert.doesNotMatch(source, /baseLinkerAccountId.*allegroAccountId/);
});

check('frontend has an aggressive realtime profile for Allegro', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tg_frontend-main', 'src', 'realtime', 'realtimePolling.js'), 'utf8');
  assert.match(source, /aggressive: Object\.freeze\(\{ connectedMs: 5_000, disconnectedMs: 3_000 \}\)/);
});

console.log(`Allegro Stage 5.2 contract: ${passed}/8 PASS`);
