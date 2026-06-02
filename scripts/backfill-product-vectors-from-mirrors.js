'use strict';

// ─── One-shot REVERSE vector backfill: shopproduct mirror → warehouse product ──
// On prod the Gemini vectors were populated on `shopproducts` FIRST (the shop
// catalog visual search shipped before the warehouse "Прийомка" search). So the
// warehouse `products` collection is the one missing vectors — the inverse of the
// "warehouse owns the vector" design in backfill-mirror-vectors.js.
//
// A shopproduct mirror (linkedProductId = product._id) shows the SAME photo as its
// warehouse owner, so its geminiVector is byte-identical. We COPY it back onto the
// warehouse product — ZERO Gemini calls. Fixes the warehouse-page visual search.
//
// Usage (run from anywhere; env is pinned to the repo-root .env):
//   node scripts/backfill-product-vectors-from-mirrors.js          # fill products missing a vector
//   node scripts/backfill-product-vectors-from-mirrors.js --force  # overwrite ALL products from their mirror
//   node scripts/backfill-product-vectors-from-mirrors.js --dry    # report only, write nothing

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY   = args.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const c = mongoose.connection;
  console.log(`[db] connected db=${c.name} force=${FORCE} dry=${DRY}`);
  const P = c.collection('products');
  const SP = c.collection('shopproducts');

  const filter = FORCE ? {} : { geminiVector: { $exists: false } };
  const cursor = P.find(filter, { projection: { _id: 1, name: 1 } });

  let scanned = 0, copied = 0, noMirror = 0, mirrorNoVec = 0;
  for (let p = await cursor.next(); p; p = await cursor.next()) {
    scanned++;
    const mirror = await SP.findOne(
      { linkedProductId: p._id, geminiVector: { $exists: true, $ne: null } },
      { projection: { geminiVector: 1, geminiEmbeddingModel: 1, geminiEmbeddingDim: 1, geminiEmbeddedAt: 1, geminiFromLabeled: 1 } },
    );
    if (!mirror) {
      // distinguish "no mirror" from "mirror without a vector"
      const any = await SP.findOne({ linkedProductId: p._id }, { projection: { _id: 1 } });
      if (any) mirrorNoVec++; else noMirror++;
      continue;
    }
    if (!DRY) {
      await P.updateOne({ _id: p._id }, { $set: {
        geminiVector:         mirror.geminiVector,
        geminiEmbeddingModel: mirror.geminiEmbeddingModel || 'gemini-embedding-2',
        geminiEmbeddingDim:   mirror.geminiEmbeddingDim || mirror.geminiVector.length,
        geminiEmbeddedAt:     mirror.geminiEmbeddedAt || new Date(),
        geminiFromLabeled:    mirror.geminiFromLabeled || false,
      } });
    }
    copied++;
    if (copied % 100 === 0) console.log(`[progress] copied=${copied} (scanned=${scanned})`);
  }

  console.log('─'.repeat(60));
  console.log(`[done] scanned=${scanned}, copied=${copied}, mirrorNoVec=${mirrorNoVec}, noMirror=${noMirror}${DRY ? ' (DRY — nothing written)' : ''}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error('fatal', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
