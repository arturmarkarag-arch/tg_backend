'use strict';

// ─── One-shot Gemini re-indexer ─────────────────────────────────────────────
// Backfills `geminiVector` for every ShopProduct that has a photo, embedding the
// CLEAN original where available (falls back to whatever photo exists and flags
// it via geminiFromLabeled). Paces requests under the free-tier 60 req/min
// limit, so ~2000 products take ~35-40 min and cost $0.
//
// Usage (from the server/ dir):
//   node scripts/reindexGemini.js                 # embed only docs missing geminiVector
//   node scripts/reindexGemini.js --force         # re-embed everything (after a model/dim change)
//   node scripts/reindexGemini.js --create-index  # also (try to) create the Atlas vector index
//   node scripts/reindexGemini.js --limit=50      # cap how many docs to process (smoke test)
//   node scripts/reindexGemini.js --delay=1100    # ms between Gemini calls (default 1100 = ~54/min)
//
// Resumable: re-running without --force picks up where it left off (skips docs
// that already have a geminiVector).

require('dotenv').config();
const mongoose = require('mongoose');
const ShopProduct = require('../models/ShopProduct');
const { initGemini, getGeminiStatus, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIMENSIONS } = require('../geminiClient');
const { embedGemini } = require('../utils/shopProductEmbedding');

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

const INDEX_NAME = 'shopproduct_gemini_vector';
const INDEX_DEFINITION = {
  name: INDEX_NAME,
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'geminiVector', numDimensions: GEMINI_EMBEDDING_DIMENSIONS, similarity: 'cosine' },
    ],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryCreateIndex() {
  try {
    const existing = await ShopProduct.collection.listSearchIndexes().toArray().catch(() => []);
    if (Array.isArray(existing) && existing.some((i) => i.name === INDEX_NAME)) {
      console.log(`[index] "${INDEX_NAME}" already exists — skipping create.`);
      return;
    }
    await ShopProduct.collection.createSearchIndex(INDEX_DEFINITION);
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
  console.log(`[db] connected. Model=${GEMINI_EMBEDDING_MODEL}, dims=${GEMINI_EMBEDDING_DIMENSIONS}, delay=${DELAY_MS}ms, force=${FORCE}`);

  if (CREATE_INDEX) await tryCreateIndex();

  // Has a photo of some kind.
  const filter = { $or: [{ imageUrl: { $ne: '' } }, { originalImageUrl: { $ne: '' } }] };
  if (!FORCE) filter.geminiVector = { $exists: false };

  const total = await ShopProduct.countDocuments(filter);
  console.log(`[reindex] ${total} product(s) to process${LIMIT ? ` (capped at ${LIMIT})` : ''}.`);

  let processed = 0, embedded = 0, failed = 0, fromLabeled = 0;
  const cursor = ShopProduct.find(filter).cursor();

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;
    try {
      const ok = await embedGemini(doc);
      if (ok) {
        await doc.save();
        embedded++;
        if (doc.geminiFromLabeled) fromLabeled++;
      } else {
        failed++;
        console.warn(`[skip] ${doc._id} (${doc.name || 'no name'}) — no photo / empty embedding`);
      }
    } catch (err) {
      failed++;
      console.error(`[fail] ${doc._id} (${doc.name || 'no name'}): ${err.message}`);
    }

    if (processed % 25 === 0 || processed === total) {
      console.log(`[progress] ${processed}/${total} — embedded=${embedded}, failed=${failed}, fromLabeled=${fromLabeled}`);
    }
    await sleep(DELAY_MS); // stay under 60 req/min
  }

  console.log('─'.repeat(60));
  console.log(`[done] processed=${processed}, embedded=${embedded}, failed=${failed}, fromLabeled=${fromLabeled}`);
  if (fromLabeled > 0) {
    console.log(`[note] ${fromLabeled} product(s) were embedded from a LABELLED photo (no clean original). ` +
      'Re-photograph + re-run to upgrade their vectors.');
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[reindexGemini] fatal:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
