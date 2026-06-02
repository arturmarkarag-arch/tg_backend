'use strict';

/*
 * Phase 1 of moving product image vectors into their own `productvectors` collection.
 *
 *   node scripts/migrate-vectors-phase1.js               # copy vectors (idempotent)
 *   node scripts/migrate-vectors-phase1.js --swap-index  # also: flip search→gemini,
 *                                                         #   drop shopproduct_vector,
 *                                                         #   create gemini_vector
 *
 * COPY is pure data movement — NO Gemini calls. The warehouse Product already owns the
 * vector; mirrors will reference it at query time (Phase 2), so we only copy:
 *   - every Product.geminiVector            → ProductVector{ productId }      (~1294)
 *   - every shop-OWNED ShopProduct.geminiVector → ProductVector{ shopProductId } (~5)
 *
 * Run from server/ so .env / MONGODB_URI load. Idempotent (upsert by owner id).
 */

// Repo-root .env (canonical server env, same as index.js) — NOT a cwd-relative one.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const AppSetting = require('../models/AppSetting');

const SWAP_INDEX = process.argv.includes('--swap-index');
const GEMINI_DIMS = 3072;
const BATCH = 100;

function vecMeta(doc) {
  return {
    geminiVector:         doc.geminiVector,
    geminiEmbeddingModel: doc.geminiEmbeddingModel || '',
    geminiEmbeddingDim:   doc.geminiEmbeddingDim || (doc.geminiVector ? doc.geminiVector.length : 0),
    geminiEmbeddedAt:     doc.geminiEmbeddedAt || new Date(),
    geminiFromLabeled:    doc.geminiFromLabeled || false,
  };
}

// Stream a find() in batches, upserting ProductVector rows keyed by `keyField`.
async function copyVectors(Model, baseFilter, keyField, label) {
  const filter = { ...baseFilter, geminiVector: { $exists: true, $ne: [] } };
  const total = await Model.countDocuments(filter);
  console.log(`[copy:${label}] ${total} doc(s) with a vector`);
  let done = 0;
  const cursor = Model.find(filter)
    .select('+geminiVector geminiEmbeddingModel geminiEmbeddingDim geminiEmbeddedAt geminiFromLabeled')
    .lean()
    .cursor();
  let ops = [];
  const flush = async () => {
    if (!ops.length) return;
    await ProductVector.bulkWrite(ops, { ordered: false });
    done += ops.length;
    ops = [];
    process.stdout.write(`\r[copy:${label}] ${done}/${total}`);
  };
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    if (!Array.isArray(doc.geminiVector) || doc.geminiVector.length === 0) continue;
    ops.push({
      updateOne: {
        filter: { [keyField]: doc._id },
        update: { $set: { [keyField]: doc._id, ...vecMeta(doc) } },
        upsert: true,
      },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  process.stdout.write('\n');
  return done;
}

async function swapIndexes() {
  // 1. Flip live search to gemini so dropping the OpenAI index can't 500 a search
  //    (gemini still reads the existing shopproduct_gemini_vector until Phase 2).
  await AppSetting.findOneAndUpdate(
    { key: 'vision.searchProvider' },
    { $set: { key: 'vision.searchProvider', value: 'gemini' } },
    { upsert: true },
  );
  console.log('[index] AppSetting vision.searchProvider = gemini');

  // 2. Drop the OpenAI index (going away) to free a search-index slot (shared tier caps at 3).
  try {
    const existing = await ShopProduct.collection.listSearchIndexes().toArray().catch(() => []);
    if (existing.some((i) => i.name === 'shopproduct_vector')) {
      await ShopProduct.collection.dropSearchIndex('shopproduct_vector');
      console.log('[index] dropped shopproduct_vector (OpenAI)');
    } else {
      console.log('[index] shopproduct_vector not present — skip drop');
    }
  } catch (err) {
    console.warn('[index] drop shopproduct_vector failed:', err.message);
  }

  // 3. Create the new vector index on productvectors.
  const def = {
    name: 'gemini_vector',
    type: 'vectorSearch',
    definition: { fields: [{ type: 'vector', path: 'geminiVector', numDimensions: GEMINI_DIMS, similarity: 'cosine' }] },
  };
  try {
    const existing = await ProductVector.collection.listSearchIndexes().toArray().catch(() => []);
    if (existing.some((i) => i.name === 'gemini_vector')) {
      console.log('[index] gemini_vector already exists — skip create');
    } else {
      await ProductVector.collection.createSearchIndex(def);
      console.log(`[index] created gemini_vector (${GEMINI_DIMS} dims, cosine). Atlas builds it in ~1 min.`);
    }
  } catch (err) {
    console.warn('[index] create gemini_vector failed:', err.message);
    console.warn('[index] create manually in Atlas → Search → JSON editor:\n', JSON.stringify(def, null, 2));
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('connected\n');

  const wh = await copyVectors(Product, { status: { $ne: 'archived' } }, 'productId', 'warehouse');
  const own = await copyVectors(ShopProduct, { linkedProductId: null }, 'shopProductId', 'shop-owned');

  const [byProduct, byShop, totalPV] = await Promise.all([
    ProductVector.countDocuments({ productId: { $exists: true } }),
    ProductVector.countDocuments({ shopProductId: { $exists: true } }),
    ProductVector.countDocuments({}),
  ]);
  console.log(`\n[copy] done — warehouse=${wh}, shop-owned=${own}`);
  console.log(`[verify] ProductVector rows: byProduct=${byProduct}, byShop=${byShop}, total=${totalPV}`);

  if (SWAP_INDEX) {
    console.log('\n--swap-index → flipping search + reindexing');
    await swapIndexes();
  } else {
    console.log('\n(no --swap-index: data copied only; re-run with --swap-index for the index swap)');
  }

  await mongoose.connection.close();
  console.log('\ndisconnected');
}

main().catch((err) => { console.error(err); process.exit(1); });
