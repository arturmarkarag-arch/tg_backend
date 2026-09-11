'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const assert = (value, message) => { if (!value) throw new Error(message); };
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (err) { checks.push([name, false, err.message]); } };
const service = read('services/commerce/allegroOfferUpdatePreview.js');
const route = read('routes/commerce.js');
const registry = read('services/commerce/providers/allegro.js');
check('preview is GET-only upstream', () => {
  assert(service.includes("method: 'GET'"), 'GET missing');
  assert(!service.includes("method: 'PATCH'"), 'PATCH leaked into 3D.4A');
});
check('content patch excludes price and stock', () => {
  assert(service.includes('const contentPatch = {}'), 'contentPatch missing');
  assert(!service.includes('contentPatch.sellingMode'), 'price leaked into contentPatch');
  assert(!service.includes('contentPatch.stock'), 'stock leaked into contentPatch');
});
check('price and stock are deferred', () => {
  assert(service.includes("'3D.5'"), 'price stage missing');
  assert(service.includes("'3D.6'"), 'stock stage missing');
});
check('mapping changes are blocked from blind patch', () => {
  assert(service.includes("'category.id'"), 'category check missing');
  assert(service.includes("'productSet[0].product.id'"), 'product mapping check missing');
  assert(service.includes('blocking: true'), 'blocking mapping rule missing');
});
check('parameter comparison accepts Allegro extras', () => {
  assert(service.includes('parameterSubsetMatches'), 'subset comparison missing');
});
check('image array replacement is explicit', () => {
  assert(service.includes('Arrays are all-or-nothing'), 'array semantics missing');
  assert(service.includes('повний масив'), 'full-image-array note missing');
});
check('route exposes update preview only', () => {
  assert(route.includes("'/publications/allegro/update-preview'"), 'route missing');
  assert(route.includes('previewAllegroOfferUpdate'), 'service wiring missing');
});
check('registry records live preview and planned write', () => {
  assert(registry.includes("id: 'offers.update.preview'"), 'preview registry missing');
  assert(registry.includes("id: 'offers.update'"), 'future write registry missing');
});
for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3D.4A backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
