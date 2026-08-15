'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pass = (name) => console.log(`✅ ${name}`);
const finding = (name, details = '') => console.log(`⚠️  ${name}${details ? ` — ${details}` : ''}`);
const fail = (name) => { console.error(`❌ ${name}`); process.exitCode = 1; };
const must = (cond, name) => cond ? pass(name) : fail(name);

const gemini = read('geminiClient.js');
const products = read('routes/products.js');
const shopProducts = read('routes/shopProducts.js');
const receipts = read('routes/receipts.js');
const vision = read('routes/visionSearch.js');
const productEmbedding = read('utils/productEmbedding.js');
const shopEmbedding = read('utils/shopProductEmbedding.js');

console.log('V48.11/V48.12 PHOTO EGRESS STATIC AUDIT');
console.log('--------------------------------------');

must(/upload-url-triple/.test(products) && /PutObjectCommand/.test(products),
  'server issues presigned R2 PUT URLs for product photo sets');
must(/Main photo \+ clean original are uploaded straight to R2 by the browser/.test(receipts),
  'receipt route documents direct browser→R2 ownership');
must(/photoFilename/.test(receipts) && /originalFilename/.test(receipts),
  'receipt route accepts R2 filenames');

const parsedFilesUses = (receipts.match(/parsed\.files/g) || []).length;
if (parsedFilesUses === 0) {
  finding('legacy Busboy can still buffer uploaded image parts, but current receipt logic never reads parsed.files',
    'not current UI traffic; removable hardening target');
} else {
  fail(`receipt route still consumes multipart file buffers (parsed.files uses=${parsedFilesUses})`);
}

const geminiArraybuffer = (gemini.match(/axios\.get\(imageUrl, \{ responseType: 'arraybuffer'/g) || []).length;
must(geminiArraybuffer === 1,
  'only embedding still downloads image bytes through Render; generative vision no longer does');
must((gemini.match(/buffer\.toString\('base64'\)/g) || []).length === 1,
  'only embedding still uses base64 image transit');
must(/\/interactions/.test(gemini)
  && /type: 'image', uri: String\(imageUrl\)/.test(gemini)
  && /store: false/.test(gemini),
  'describe/translate/ask use Gemini Interactions with external R2 URL and store:false');
must(/steps/.test(gemini) && /model_output/.test(gemini) && /step\.content/.test(gemini),
  'Interactions response text is parsed from model_output steps');

const proxyHasFetch = /router\.get\('\/proxy-image'[\s\S]*axios\.get\(url, \{ responseType: 'arraybuffer'/.test(products);
const proxyHasSend = /router\.get\('\/proxy-image'[\s\S]*res\.send\(Buffer\.from\(upstream\.data\)\)/.test(products);
must(proxyHasFetch && proxyHasSend,
  '/products/proxy-image remains an explicit R2→Render→browser byte proxy for canvas/CORS');

must(/const embeddingInFlight = new Map\(\)/.test(productEmbedding)
  && /embeddingInFlight\.get\(key\)/.test(productEmbedding)
  && /embeddingInFlight\.set\(key, job\)/.test(productEmbedding),
  'warehouse embedding has same-source single-flight');
must(/const embeddingInFlight = new Map\(\)/.test(shopEmbedding)
  && /embeddingInFlight\.get\(key\)/.test(shopEmbedding)
  && /embeddingInFlight\.set\(key, job\)/.test(shopEmbedding),
  'shop-owned embedding has same-source single-flight');

must(/previousEmbeddingSource = getProductEmbeddingSource\(product\)\.url/.test(products)
  && /embeddingSourceChanged = nextEmbeddingSource !== previousEmbeddingSource/.test(products)
  && /force: embeddingSourceChanged/.test(products),
  'warehouse PATCH does not force re-embed when only annotated image changed');
must(/previousEmbeddingSource = getProductEmbeddingSource\(product\)\.url/.test(shopProducts)
  && /previousEmbeddingSource = getShopProductEmbeddingSource\(item\)\.url/.test(shopProducts)
  && /force: nextEmbeddingSource !== previousEmbeddingSource/.test(shopProducts),
  'shop-side edits only force re-embed when the actual embedding source changes');

must(!/Gemini reads it by URL \(no bytes through us\)/.test(vision),
  'visionSearch no longer claims embedding bypasses Render');

finding('embedding image bytes still transit Render',
  'Gemini Embedding 2 docs currently describe image input as inline data or Files API; keep the URL capability probe separate');
const sample = 719751;
const b64 = Math.ceil(sample / 3) * 4;
console.log(`ℹ️  remaining embedding base64 math: ${sample} image bytes → ~${b64} base64 bytes (${(b64 / sample).toFixed(3)}× before JSON/TLS)`);

if (!process.exitCode) console.log('\nPHOTO EGRESS STATIC AUDIT: PASS');
