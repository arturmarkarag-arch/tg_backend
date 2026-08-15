'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failed = false;
function check(cond, name) {
  if (cond) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failed = true; }
}

const gemini = read('geminiClient.js');
const warehouse = read('utils/productEmbedding.js');
const shop = read('utils/shopProductEmbedding.js');
const products = read('routes/products.js');
const shopProducts = read('routes/shopProducts.js');
const liveProbe = read('scripts/livePhotoEgressProbeV48_11.js');

check(/type: 'image', uri: String\(imageUrl\)/.test(gemini), 'vision uses external image URL');
check(/store: false/.test(gemini), 'Interactions calls are stateless');
check(/step\?\.type === 'model_output'/.test(gemini) && /step\.content/.test(gemini), 'Interactions response parser reads model_output steps');
check((gemini.match(/axios\.get\(imageUrl/g) || []).length === 1, 'only embedding fetches image bytes on Render');
check((gemini.match(/buffer\.toString\('base64'\)/g) || []).length === 1, 'only embedding base64-encodes image bytes');
check(/embeddingInFlight = new Map\(\)/.test(warehouse) && /embeddingInFlight\.get\(key\)/.test(warehouse), 'warehouse single-flight guard present');
check(/embeddingInFlight = new Map\(\)/.test(shop) && /embeddingInFlight\.get\(key\)/.test(shop), 'shop-owned single-flight guard present');
check(/embeddingSourceChanged = nextEmbeddingSource !== previousEmbeddingSource/.test(products), 'warehouse patch compares actual embedding source');
check(/force: nextEmbeddingSource !== previousEmbeddingSource/.test(shopProducts), 'shop patch compares actual embedding source');
check(/UNKNOWN \(auth rejected before capability could be tested\)/.test(liveProbe), 'live probe does not misreport auth failure as unsupported embedding URL');

if (failed) process.exit(1);
console.log('V48.12 PHOTO EGRESS HARDENING: PASS');
