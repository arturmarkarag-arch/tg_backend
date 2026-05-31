'use strict';
/**
 * One-time migration: rewrite stored product-image URLs from one host to another
 * (e.g. the rate-limited `pub-xxx.r2.dev` dev URL → your R2 custom domain
 * `img.zlotoweczka.com.pl`). Only the HOST changes; the `/folder/file` path is
 * preserved, so the very same R2 objects are served — just through the
 * CDN-backed custom domain (no more 429, edge caching kicks in).
 *
 * SAFE BY DEFAULT: dry-run. It prints how many docs/fields WOULD change plus a
 * few before→after samples and writes NOTHING. Pass --apply to actually update.
 *
 * Usage (run from the server/ directory so .env / MONGODB_URI load):
 *   node scripts/migrate-image-host.js --old https://pub-xxx.r2.dev --new https://img.zlotoweczka.com.pl
 *   node scripts/migrate-image-host.js --old ... --new ... --apply
 *
 * Hosts may also be supplied via env: OLD_IMAGE_HOST / NEW_IMAGE_HOST.
 * MONGODB_URI is read from .env (or the environment).
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const OLD = (arg('old') || process.env.OLD_IMAGE_HOST || '').replace(/\/+$/, '');
const NEW = (arg('new') || process.env.NEW_IMAGE_HOST || '').replace(/\/+$/, '');
const URI = process.env.MONGODB_URI || arg('uri');

// Collections → URL-bearing fields (string + string[]). Extra field names are
// harmless: a field is only touched when it actually holds a string under OLD.
const TARGETS = [
  { collection: 'products',     stringFields: ['originalImageUrl', 'localImageUrl', 'image_url'], arrayFields: ['imageUrls'] },
  { collection: 'shopproducts', stringFields: ['imageUrl', 'originalImageUrl', 'localImageUrl', 'image_url'], arrayFields: ['imageUrls'] },
];

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function rewrite(value) {
  if (typeof value !== 'string' || !value.startsWith(`${OLD}/`)) return null;
  return NEW + value.slice(OLD.length);
}

async function main() {
  if (!URI) { console.error('✖ MONGODB_URI not set — run from server/ (with .env) or pass --uri.'); process.exit(1); }
  if (!OLD || !NEW) { console.error('✖ Provide --old and --new hosts (or OLD_IMAGE_HOST/NEW_IMAGE_HOST).'); process.exit(1); }
  if (OLD === NEW) { console.error('✖ --old and --new are identical; nothing to do.'); process.exit(1); }

  console.log(`\n[migrate-image-host] ${APPLY ? '⚙ APPLY (writing)' : '🔍 DRY-RUN (no writes)'}`);
  console.log(`  old host: ${OLD}`);
  console.log(`  new host: ${NEW}\n`);

  await mongoose.connect(URI);
  const db = mongoose.connection.db;

  let totalDocs = 0, totalFields = 0;
  const samples = [];

  for (const { collection, stringFields, arrayFields } of TARGETS) {
    const col = db.collection(collection);
    const orClauses = [...stringFields, ...arrayFields].map((f) => ({ [f]: { $regex: `^${escapeRegex(OLD)}/` } }));
    const cursor = col.find({ $or: orClauses }, { projection: Object.fromEntries([...stringFields, ...arrayFields].map((f) => [f, 1])) });

    let colDocs = 0, colFields = 0;
    for await (const doc of cursor) {
      const set = {};
      for (const f of stringFields) {
        const nv = rewrite(doc[f]);
        if (nv) { if (samples.length < 8) samples.push({ collection, _id: doc._id, field: f, before: doc[f], after: nv }); set[f] = nv; colFields++; }
      }
      for (const f of arrayFields) {
        if (!Array.isArray(doc[f])) continue;
        let changed = false;
        const arr = doc[f].map((v) => {
          const nv = rewrite(v);
          if (nv) { changed = true; colFields++; if (samples.length < 8) samples.push({ collection, _id: doc._id, field: `${f}[]`, before: v, after: nv }); return nv; }
          return v;
        });
        if (changed) set[f] = arr;
      }
      if (Object.keys(set).length) {
        colDocs++;
        if (APPLY) await col.updateOne({ _id: doc._id }, { $set: set });
      }
    }
    console.log(`  ${collection.padEnd(14)} ${colDocs} docs, ${colFields} fields ${APPLY ? 'updated' : 'to update'}`);
    totalDocs += colDocs; totalFields += colFields;
  }

  if (samples.length) {
    console.log('\n  Sample changes:');
    for (const s of samples) {
      console.log(`    [${s.collection} ${s._id}] ${s.field}`);
      console.log(`        − ${s.before}`);
      console.log(`        + ${s.after}`);
    }
  }

  console.log(`\n  TOTAL: ${totalDocs} docs, ${totalFields} fields ${APPLY ? 'updated ✓' : 'to update'}`);
  if (!APPLY) console.log('  DRY-RUN — nothing written. Re-run with --apply to commit.\n');
  else console.log('  Done.\n');

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
