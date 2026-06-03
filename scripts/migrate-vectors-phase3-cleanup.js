'use strict';

/*
 * Phase 3b — DESTRUCTIVE cleanup, run ONLY AFTER the new code (ProductVector search +
 * embedding) is deployed and verified in production.
 *
 *   node scripts/migrate-vectors-phase3-cleanup.js            # dry-run (counts only)
 *   node scripts/migrate-vectors-phase3-cleanup.js --confirm  # actually $unset + drop indexes
 *
 * What it does:
 *   1. $unset the now-redundant vector fields from every Product / ShopProduct doc
 *      (the vectors live in the productvectors collection now).
 *   2. Drop the old Atlas Search indexes (product_gemini_vector, shopproduct_gemini_vector)
 *      — the live search reads `gemini_vector` on productvectors after the deploy.
 *
 * ⚠️  If you run this while OLD code is still live, warehouse + seller search break,
 *     because the old code reads geminiVector straight off the product docs / old
 *     indexes. Deploy first. ProductVector already holds every vector (Phase 1), and
 *     you have backups, so this only removes duplicates.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');

const CONFIRM = process.argv.includes('--confirm');

const PRODUCT_VEC_FIELDS = {
  geminiVector: '', geminiEmbeddingModel: '', geminiEmbeddingDim: '', geminiEmbeddedAt: '', geminiFromLabeled: '',
};
const SHOP_VEC_FIELDS = {
  ...PRODUCT_VEC_FIELDS,
  embedding: '', embeddingModel: '', embeddedAt: '', descriptor: '',
};

async function avgSize(Model, filter = {}) {
  // read('primary') so a freshly-written change isn't masked by a lagging secondary.
  const [s] = await Model.aggregate([{ $match: filter }, { $group: { _id: null, avg: { $avg: { $bsonSize: '$$ROOT' } }, n: { $sum: 1 } } }]).read('primary');
  return s ? { avgKB: Math.round((s.avg / 1024) * 10) / 10, n: s.n } : { avgKB: 0, n: 0 };
}

// $unset MUST go through the native driver (.collection), NOT the Mongoose model.
// These vector fields were dropped from the schema, so Mongoose strict-mode silently
// strips them out of the $unset operator before it reaches Mongo — the update then
// reports modifiedCount>0 while removing NOTHING. The native collection bypasses the
// schema and actually deletes the paths. Filter to docs that still carry a field so
// modifiedCount is truthful.
async function unsetFields(Model, fields) {
  const keys = Object.keys(fields);
  return Model.collection.updateMany(
    { $or: keys.map((k) => ({ [k]: { $exists: true } })) },
    { $unset: fields },
  );
}

async function dropIndex(Model, name) {
  try {
    const existing = await Model.collection.listSearchIndexes().toArray().catch(() => []);
    if (!existing.some((i) => i.name === name)) { console.log(`[index] ${name} not present — skip`); return; }
    await Model.collection.dropSearchIndex(name);
    console.log(`[index] dropped ${name}`);
  } catch (err) {
    console.warn(`[index] drop ${name} failed: ${err.message}`);
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('connected\n');

  // Safety: confirm every product vector is already in productvectors before deleting.
  const pvProduct = await ProductVector.countDocuments({ productId: { $exists: true } });
  const pvShop    = await ProductVector.countDocuments({ shopProductId: { $exists: true } });
  console.log(`[guard] ProductVector rows: byProduct=${pvProduct}, byShop=${pvShop}`);
  if (pvProduct === 0) {
    console.error('[guard] ABORT — productvectors is empty; run Phase 1 (migrate-vectors-phase1.js) first.');
    await mongoose.connection.close();
    process.exit(1);
  }

  const beforeP = await avgSize(Product);
  const beforeS = await avgSize(ShopProduct);
  console.log(`[before] Product avg=${beforeP.avgKB} KB (n=${beforeP.n}) | ShopProduct avg=${beforeS.avgKB} KB (n=${beforeS.n})`);

  if (!CONFIRM) {
    console.log('\nDRY-RUN — pass --confirm to $unset the fields and drop the old indexes.');
    await mongoose.connection.close();
    return;
  }

  console.log('\n--confirm → unsetting fields + dropping old indexes');
  const rP = await unsetFields(Product, PRODUCT_VEC_FIELDS);
  console.log(`[unset] Product: matched=${rP.matchedCount}, modified=${rP.modifiedCount}`);
  const rS = await unsetFields(ShopProduct, SHOP_VEC_FIELDS);
  console.log(`[unset] ShopProduct: matched=${rS.matchedCount}, modified=${rS.modifiedCount}`);

  await dropIndex(Product, 'product_gemini_vector');
  await dropIndex(ShopProduct, 'shopproduct_gemini_vector');

  const afterP = await avgSize(Product);
  const afterS = await avgSize(ShopProduct);
  console.log(`\n[after] Product avg=${afterP.avgKB} KB | ShopProduct avg=${afterS.avgKB} KB`);
  console.log('[done] cleanup complete.');

  await mongoose.connection.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
