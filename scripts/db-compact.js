'use strict';

/**
 * Reclaim WiredTiger free space left behind by the vector $unset migration.
 * Runs db.runCommand({ compact }) on the bloated collections and reports the
 * before/after storage. compact holds the collection briefly — safe on a small
 * test-phase DB. On Atlas shared/serverless tiers compact is blocked; the script
 * catches that and reports instead of crashing.
 *
 * Usage: node server/scripts/db-compact.js [coll1 coll2 ...]
 * Default targets: shopproducts products
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['shopproducts', 'products'];
const MB = (b) => (b == null ? '—' : `${(b / 1024 / 1024).toFixed(1)} MB`);

async function stats(db, name) {
  const s = await db.command({ collStats: name });
  return { storageSize: s.storageSize, freeStorageSize: s.freeStorageSize ?? null, size: s.size, count: s.count };
}

(async () => {
  const URI = process.env.MONGODB_URI;
  if (!URI) throw new Error('MONGODB_URI is required (.env)');

  // Print only the host so we know the cluster type — never the credentials.
  try {
    const host = URI.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '$1://').replace(/^mongodb/, 'mongodb');
    const m = URI.match(/@([^/?]+)/);
    console.log(`\nCluster host: ${m ? m[1] : '(parse failed)'}${URI.startsWith('mongodb+srv') ? '  [srv → likely Atlas]' : ''}`);
  } catch { /* ignore */ }

  await mongoose.connect(URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const db = mongoose.connection.db;
  console.log(`DB: ${db.databaseName}\n`);

  let totalReclaimed = 0;
  for (const name of TARGETS) {
    try {
      const before = await stats(db, name);
      process.stdout.write(`${name.padEnd(16)} before: ${MB(before.storageSize)} storage (${before.count} docs, data ${MB(before.size)})\n`);
      const t0 = Date.now();
      await db.command({ compact: name });
      const after = await stats(db, name);
      const reclaimed = (before.storageSize || 0) - (after.storageSize || 0);
      totalReclaimed += reclaimed;
      console.log(`${name.padEnd(16)} after : ${MB(after.storageSize)} storage  →  reclaimed ${MB(reclaimed)} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    } catch (e) {
      console.log(`${name.padEnd(16)} SKIPPED — compact failed: ${e.codeName || e.code || ''} ${e.message}\n`);
    }
  }

  console.log(`=== Total reclaimed: ${MB(totalReclaimed)} ===`);
  await mongoose.connection.close();
})().catch((e) => { console.error(e); process.exit(1); });
