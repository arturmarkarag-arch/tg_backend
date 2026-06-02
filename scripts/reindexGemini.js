'use strict';

// ─── One-shot Gemini (re)indexer → ProductVector ────────────────────────────
// Backfills the ProductVector collection by EMBEDDING the CLEAN original photo
// (falls back to whatever photo exists, flagged via geminiFromLabeled). Paces
// requests under the free-tier 60 req/min limit, so ~1300 products take ~25 min, $0.
//
// Scope: warehouse `products` (→ ProductVector{productId}) and shop-OWNED
// `shopproducts` (linkedProductId: null → ProductVector{shopProductId}). Linked
// MIRRORS are NEVER embedded — the seller search resolves them to their warehouse
// owner's ProductVector row at query time (zero duplicate vectors).
//
// Usage (from the server/ dir):
//   node scripts/reindexGemini.js                 # embed only docs missing a ProductVector row
//   node scripts/reindexGemini.js --force         # re-embed everything (after a model/dim change)
//   node scripts/reindexGemini.js --create-index  # also (try to) create the Atlas vector index
//   node scripts/reindexGemini.js --limit=50      # cap how many docs to process (smoke test)
//   node scripts/reindexGemini.js --delay=1100    # ms between Gemini calls (default 1100 = ~54/min)
//   node scripts/reindexGemini.js --collection=products       # warehouse (Товари Складу, default)
//   node scripts/reindexGemini.js --collection=shopproducts   # shop-owned catalogue items
//
// Resumable: re-running without --force skips docs that already have a ProductVector row.

// Pin the env to the repo-root .env (the canonical server env, same as index.js).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const ShopProduct = require('../models/ShopProduct');
const Product     = require('../models/Product');
const ProductVector = require('../models/ProductVector');
const { initGemini, getGeminiStatus, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS } = require('../geminiClient');
const { embedProduct } = require('../utils/productEmbedding');
const { embedShopProduct } = require('../utils/shopProductEmbedding');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (k, d) => {
  const a = args.find((x) => x.startsWith(`${k}=`));
  return a ? a.slice(k.length + 1) : d;
};

const FORCE        = hasFlag('--force');
const CREATE_INDEX = hasFlag('--create-index');
const LIMIT        = parseInt(flagVal('--limit', '0'), 10) || 0;
const DELAY_MS     = parseInt(flagVal('--delay', '1100'), 10);

// --collection=products (Товари Складу, default) | shopproducts (shop-owned only)
const COLLECTION = String(flagVal('--collection', 'products')).toLowerCase();
const TARGETS = {
  products: {
    Model: Product,
    embed: (doc) => embedProduct(doc, { force: FORCE }),
    photoFilter: { status: { $ne: 'archived' }, $or: [{ originalImageUrl: { $ne: '' } }, { 'imageUrls.0': { $exists: true } }] },
    vecKey: 'productId',
  },
  shopproducts: {
    Model: ShopProduct,
    embed: (doc) => embedShopProduct(doc, { force: FORCE }),
    photoFilter: { linkedProductId: null, $or: [{ imageUrl: { $ne: '' } }, { originalImageUrl: { $ne: '' } }] },
    vecKey: 'shopProductId',
  },
};
const TARGET = TARGETS[COLLECTION];
if (!TARGET) {
  console.error(`Unknown --collection="${COLLECTION}" (use: products | shopproducts)`);
  process.exit(1);
}

const INDEX_NAME = 'gemini_vector';
const INDEX_DEFINITION = {
  name: INDEX_NAME,
  type: 'vectorSearch',
  definition: { fields: [{ type: 'vector', path: 'geminiVector', numDimensions: GEMINI_EMBEDDING_DIMENSIONS, similarity: 'cosine' }] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryCreateIndex() {
  try {
    const existing = await ProductVector.collection.listSearchIndexes().toArray().catch(() => []);
    if (existing.some((i) => i.name === INDEX_NAME)) {
      console.log(`[index] "${INDEX_NAME}" already exists — skipping create.`);
      return;
    }
    await ProductVector.collection.createSearchIndex(INDEX_DEFINITION);
    console.log(`[index] created "${INDEX_NAME}" (${GEMINI_EMBEDDING_DIMENSIONS} dims, cosine). Atlas needs ~1 min to build it.`);
  } catch (err) {
    console.warn(`[index] auto-create failed: ${err.message}`);
    console.warn('[index] Create it manually in Atlas → Atlas Search → Create Search Index → JSON editor:');
    console.warn(JSON.stringify(INDEX_DEFINITION, null, 2));
  }
}

async function main() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is required (.env)');

  initGemini(process.env.GEMINI_API_KEY);
  if (!getGeminiStatus().connected) {
    throw new Error(getGeminiStatus().error || 'GEMINI_API_KEY not configured');
  }

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`[db] connected. Collection=${COLLECTION} → ProductVector, model=${GEMINI_EMBEDDING_MODEL}, dims=${GEMINI_EMBEDDING_DIMENSIONS}, delay=${DELAY_MS}ms, force=${FORCE}`);

  if (CREATE_INDEX) await tryCreateIndex();

  // Resume: skip docs that already own a ProductVector row (unless --force).
  let skipIds = new Set();
  if (!FORCE) {
    const have = await ProductVector.find({ [TARGET.vecKey]: { $exists: true } }, TARGET.vecKey).lean();
    skipIds = new Set(have.map((v) => String(v[TARGET.vecKey])));
  }

  const candidates = await TARGET.Model.find(TARGET.photoFilter).lean();
  const todo = candidates.filter((d) => FORCE || !skipIds.has(String(d._id)));
  const total = LIMIT ? Math.min(LIMIT, todo.length) : todo.length;
  console.log(`[reindex] ${todo.length} candidate(s)${LIMIT ? `, capped at ${LIMIT}` : ''} → ${total} to process.`);

  let processed = 0, embedded = 0, failed = 0;
  for (const doc of todo) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;
    try {
      if (await TARGET.embed(doc)) {
        embedded++;
        await sleep(DELAY_MS); // pace only real Gemini calls
      } else {
        failed++;
        console.warn(`[skip] ${doc._id} (${doc.name || 'no name'}) — no photo / empty embedding`);
      }
    } catch (err) {
      failed++;
      console.error(`[fail] ${doc._id} (${doc.name || 'no name'}): ${err.message}`);
    }
    if (processed % 25 === 0 || processed === total) {
      console.log(`[progress] ${processed}/${total} — embedded=${embedded}, failed=${failed}`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`[done] processed=${processed}, embedded=${embedded}, failed=${failed}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[reindexGemini] fatal:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
