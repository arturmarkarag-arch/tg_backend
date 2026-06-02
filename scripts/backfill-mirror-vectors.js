'use strict';

// ─── One-shot mirror-vector backfill ────────────────────────────────────────
// Copies each warehouse Product's `geminiVector` onto its linked ShopProduct
// mirrors — with ZERO Gemini calls. A mirror shows the SAME photo as its
// warehouse owner (upsertShopProduct copies the photo across), so the vector is
// byte-identical; computing it again would only burn the free-tier 60 req/min
// quota. This fills existing mirrors that were embedded separately before the
// "warehouse owns the vector" change. Idempotent + resumable.
//
// Order of operations for a full reindex:
//   1. node scripts/reindexGemini.js --collection=products   # embed warehouse owners
//   2. node scripts/backfill-mirror-vectors.js               # copy owner → mirrors
//   3. node scripts/reindexGemini.js --collection=shopproducts  # shop-OWNED only
//
// Usage (from the server/ dir):
//   node scripts/backfill-mirror-vectors.js          # copy owner → mirror for all mirrors
//   node scripts/backfill-mirror-vectors.js --dry    # report only, write nothing

// Pin the env to the repo-root .env (same as index.js), NOT a cwd-relative .env —
// otherwise running from server/ silently loads a stale server/.env (wrong DB).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const { propagateGeminiVectorToMirrors } = require('../utils/productEmbedding');

const DRY = process.argv.includes('--dry');

async function main() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is required (.env)');

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`[db] connected. mode=${DRY ? 'DRY-RUN' : 'APPLY'}`);

  // Warehouse owners that actually have a vector to give.
  const filter = { geminiVector: { $exists: true, $type: 'array' } };
  const total = await Product.countDocuments(filter);
  console.log(`[backfill] ${total} warehouse product(s) with a vector to propagate.`);

  // geminiVector is schema select:false — the leading `+` forces it back into the
  // projection so propagateGeminiVectorToMirrors actually has a vector to copy.
  const cursor = Product.find(
    filter,
    '+geminiVector geminiEmbeddingModel geminiEmbeddingDim geminiEmbeddedAt geminiFromLabeled',
  ).cursor();

  let owners = 0, mirrors = 0;
  for (let p = await cursor.next(); p != null; p = await cursor.next()) {
    owners++;
    if (DRY) {
      mirrors += await ShopProduct.countDocuments({ linkedProductId: p._id, geminiVector: { $exists: false } });
    } else {
      mirrors += await propagateGeminiVectorToMirrors(p);
    }
    if (owners % 100 === 0) console.log(`[progress] ${owners}/${total} owners — mirrors ${DRY ? 'pending' : 'updated'}=${mirrors}`);
  }

  // Mirrors still without a vector because their warehouse owner has none yet.
  const orphans = await ShopProduct.countDocuments({
    linkedProductId: { $ne: null },
    geminiVector: { $exists: false },
  });

  console.log('─'.repeat(60));
  console.log(`[done] owners-with-vector=${owners}, mirrors-${DRY ? 'to-update' : 'updated'}=${mirrors}`);
  if (orphans > 0) {
    console.log(`[note] ${orphans} mirror(s) still without a vector — their warehouse owner isn't embedded yet.`);
    console.log('       Run: node scripts/reindexGemini.js --collection=products   then re-run this script.');
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[backfill-mirror-vectors] fatal:', err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
