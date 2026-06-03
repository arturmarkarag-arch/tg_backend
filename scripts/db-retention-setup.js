'use strict';

/**
 * Apply the retention policy to the LIVE DB now (instead of waiting for a deploy):
 *   - build/refresh the TTL indexes on the audit/log collections via the same
 *     model.syncIndexes() path the server runs at boot (ShopAuditLog 180d,
 *     ReceiptItemLog + VisionTestLog 365d);
 *   - drop the dead, empty `activitylogs` collection (removed from the codebase);
 *   - run the initial completed-PickingTask purge (>30d).
 * Idempotent + safe to re-run. Reports the resulting TTL indexes for verification.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const ShopAuditLog = require('../models/ShopAuditLog');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const VisionTestLog = require('../models/VisionTestLog');
const { purgeOldCompletedPickingTasks, COMPLETED_PICKING_RETENTION_DAYS } = require('../services/retention');

const days = (s) => (s == null ? '—' : `${Math.round(s / 86400)}d`);

async function showTtl(db, coll) {
  try {
    const idx = await db.collection(coll).indexes();
    const ttl = idx.filter((i) => i.expireAfterSeconds != null);
    ttl.forEach((i) => console.log(`    ${coll}.${i.name}  TTL=${days(i.expireAfterSeconds)}`));
    if (!ttl.length) console.log(`    ${coll}: (no TTL index!)`);
  } catch (e) { console.log(`    ${coll}: ${e.message}`); }
}

(async () => {
  const URI = process.env.MONGODB_URI;
  if (!URI) throw new Error('MONGODB_URI is required (.env)');
  await mongoose.connect(URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const db = mongoose.connection.db;
  console.log(`\nDB: ${db.databaseName}\n`);

  // 1) TTL indexes — same code path as server boot (drops old plain index, builds TTL)
  console.log('1) Building TTL indexes…');
  await ShopAuditLog.syncIndexes();
  await ReceiptItemLog.syncIndexes();
  await VisionTestLog.syncIndexes();
  await showTtl(db, 'shopauditlogs');
  await showTtl(db, 'receiptitemlogs');
  await showTtl(db, 'visiontestlogs');

  // 2) Drop the dead, empty activitylogs collection
  console.log('\n2) Dropping dead activitylogs collection…');
  const exists = (await db.listCollections({ name: 'activitylogs' }).toArray()).length > 0;
  if (!exists) {
    console.log('    activitylogs: not present (already gone)');
  } else {
    const n = await db.collection('activitylogs').countDocuments();
    if (n === 0) {
      await db.collection('activitylogs').drop();
      console.log('    activitylogs: dropped (was empty)');
    } else {
      console.log(`    activitylogs: KEPT — has ${n} docs (not empty); inspect before dropping`);
    }
  }

  // 3) Initial completed-PickingTask purge
  console.log(`\n3) Purging completed picking tasks older than ${COMPLETED_PICKING_RETENTION_DAYS}d…`);
  const purged = await purgeOldCompletedPickingTasks();
  console.log(`    deleted ${purged} task(s)`);

  await mongoose.connection.close();
  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });
