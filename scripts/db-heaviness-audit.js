'use strict';

/**
 * READ-ONLY diagnostic: find where document/collection weight accumulates.
 * - collStats per collection (count, avgObjSize, storageSize, totalIndexSize)
 * - array-length distribution (avg / p95 / max + the heaviest doc) for the
 *   embedded arrays that grow over time.
 * No writes. Run from anywhere: node server/scripts/db-heaviness-audit.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const fmtKB = (b) => (b == null ? '—' : `${(b / 1024).toFixed(1)} KB`);
const fmtMB = (b) => (b == null ? '—' : `${(b / 1024 / 1024).toFixed(1)} MB`);

async function collStats(db, name) {
  try {
    const s = await db.command({ collStats: name });
    return {
      name,
      count: s.count || 0,
      avgObjSize: s.avgObjSize || 0,
      size: s.size || 0,
      storageSize: s.storageSize || 0,
      totalIndexSize: s.totalIndexSize || 0,
    };
  } catch {
    return null;
  }
}

// avg / p95 / max length of an array field + the _id of the heaviest doc
async function arrayLenStats(coll, field, idField = '_id') {
  const pipeline = [
    { $project: { len: { $size: { $ifNull: [`$${field}`, []] } }, key: `$${idField}` } },
    { $sort: { len: -1 } },
  ];
  const docs = await coll.aggregate(pipeline).toArray();
  if (!docs.length) return { count: 0 };
  const lens = docs.map((d) => d.len);
  const sum = lens.reduce((a, b) => a + b, 0);
  const p95 = lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.05))];
  return {
    count: docs.length,
    avg: (sum / docs.length).toFixed(1),
    p95,
    max: lens[0],
    maxKey: docs[0].key,
    nonEmpty: lens.filter((l) => l > 0).length,
  };
}

(async () => {
  const URI = process.env.MONGODB_URI;
  if (!URI) throw new Error('MONGODB_URI is required (.env)');
  await mongoose.connect(URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const db = mongoose.connection.db;
  console.log(`\nDB: ${db.databaseName}\n`);

  // 1) Collection-level weight, sorted by storage size
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const stats = (await Promise.all(names.map((n) => collStats(db, n)))).filter(Boolean);
  stats.sort((a, b) => b.storageSize - a.storageSize);

  console.log('=== COLLECTIONS (by storage) ===');
  console.log(
    ['collection'.padEnd(22), 'docs'.padStart(8), 'avgObj'.padStart(10), 'data'.padStart(10), 'storage'.padStart(10), 'indexes'.padStart(10)].join(' '),
  );
  for (const s of stats) {
    console.log(
      [
        s.name.padEnd(22),
        String(s.count).padStart(8),
        fmtKB(s.avgObjSize).padStart(10),
        fmtMB(s.size).padStart(10),
        fmtMB(s.storageSize).padStart(10),
        fmtMB(s.totalIndexSize).padStart(10),
      ].join(' '),
    );
  }

  // 2) Embedded-array growth (the "one heavy document" risk)
  console.log('\n=== EMBEDDED ARRAY LENGTHS ===');
  const targets = [
    ['users', 'history', 'telegramId'],
    ['orderingsessions', 'events', '_id'],
    ['orders', 'history', '_id'],
    ['orders', 'items', '_id'],
    ['pickingtasks', 'items', '_id'],
    ['blocks', 'productIds', 'blockId'],
    ['deliverygroups', 'members', 'name'],
    ['products', 'imageUrls', '_id'],
    ['products', 'telegramMessageIds', '_id'],
  ];
  for (const [collName, field, idField] of targets) {
    if (!names.includes(collName)) continue;
    const r = await arrayLenStats(db.collection(collName), field, idField);
    if (!r.count) { console.log(`${collName}.${field}: (empty collection)`); continue; }
    console.log(
      `${`${collName}.${field}`.padEnd(34)} docs=${String(r.count).padStart(6)}  nonEmpty=${String(r.nonEmpty).padStart(6)}  avg=${String(r.avg).padStart(5)}  p95=${String(r.p95).padStart(4)}  MAX=${String(r.max).padStart(5)}  (heaviest ${idField}=${r.maxKey})`,
    );
  }

  // 3) PickingTask status breakdown (completed tasks live forever)
  if (names.includes('pickingtasks')) {
    const byStatus = await db.collection('pickingtasks').aggregate([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]).toArray();
    console.log('\n=== PICKINGTASK by status ===');
    byStatus.forEach((s) => console.log(`  ${String(s._id).padEnd(12)} ${s.n}`));
  }

  await mongoose.connection.close();
  console.log('\nDone (read-only).');
})().catch((e) => { console.error(e); process.exit(1); });
