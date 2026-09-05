'use strict';

// Default: read-only inventory. This script is NEVER called by server startup.
// Apply creates a BSON-preserving local backup before any database mutation.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MongoClient, BSON } = require('mongoose').mongo;

const USER_FIELDS = [
  'permissions.baseLinkerPicking', 'isOnline', 'lastActive',
  'isWarehouseManager', 'isOnShift', 'shiftZone',
  'cartState.orderItems', 'cartState.orderItemIds', 'cartState.lastOrderPositions',
  'cartState.lastViewedOrderNumber', 'cartState.currentPage', 'cartState.reservedForGroupId',
  'miniAppState.lastViewedProductId', 'miniAppState.currentIndex', 'miniAppState.currentPage', 'miniAppState.viewMode',
];
const TRANSFER_LEGACY_FIELDS = [
  'cartDecision', 'displacedSellerDecision', 'displacedSellerTelegramId',
  'conflictSnapshot.cartHasItems', 'conflictSnapshot.cartItemCount',
  'conflictSnapshot.targetSellerCartHasItems', 'conflictSnapshot.targetSellerCartItemCount',
];
const FIELDS_BY_COLLECTION = { users: USER_FIELDS, shoptransferrequests: TRANSFER_LEGACY_FIELDS };
const existsAny = (fields) => ({ $or: fields.map((field) => ({ [field]: { $exists: true } })) });
const valueAt = (doc, field) => field.split('.').reduce((value, key) => value?.[key], doc);

function snapshotGuard(document, fields) {
  return Object.fromEntries([
    ['_id', document._id],
    ...fields.map((field) => {
      const value = valueAt(document, field);
      return [field, value === undefined ? { $exists: false } : { $eq: value }];
    }),
  ]);
}

async function main() {
  if (process.env.NODE_ENV !== 'production') require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');
  const backupAt = process.argv.indexOf('--backup');
  const backupFile = backupAt >= 0 ? process.argv[backupAt + 1] : '';
  if (apply && (!backupFile || !path.isAbsolute(backupFile))) throw new Error('--apply requires --backup /absolute/path/to/new-file.jsonl');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  let fd;
  try {
    await client.connect();
    const db = client.db();
    console.log(`${apply ? 'BACKUP + APPLY' : 'READ-ONLY DRY RUN'} database=${db.databaseName}`);
    for (const [collection, fields] of Object.entries(FIELDS_BY_COLLECTION)) {
      console.log(`${collection}: ${await db.collection(collection).countDocuments(existsAny(fields))} documents with retired fields`);
    }
    if (!apply) return;

    // Refuse to overwrite an existing backup. No URI, credentials or tokens are
    // logged; only the exact retired fields and document IDs go into this file.
    fd = fs.openSync(backupFile, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ kind: 'user-directory-legacy-backup-v1', database: db.databaseName, createdAt: new Date().toISOString() }) + '\n');
    for (const [collection, fields] of Object.entries(FIELDS_BY_COLLECTION)) {
      const projection = Object.fromEntries(fields.map((field) => [field, 1]));
      for await (const document of db.collection(collection).find(existsAny(fields), { projection })) {
        fs.writeSync(fd, BSON.EJSON.stringify({ collection, document }, { relaxed: false }) + '\n');
      }
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    let modified = 0, changedSinceBackup = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(backupFile), crlfDelay: Infinity });
    for await (const line of lines) {
      const entry = BSON.EJSON.parse(line, { relaxed: false });
      if (!entry.collection) continue;
      const fields = FIELDS_BY_COLLECTION[entry.collection];
      const result = await db.collection(entry.collection).updateOne(
        snapshotGuard(entry.document, fields),
        { $unset: Object.fromEntries(fields.map((field) => [field, ''])) },
      );
      modified += result.modifiedCount;
      if (!result.matchedCount) changedSinceBackup += 1;
    }
    console.log(`Cleaned=${modified}; skipped because fields changed after backup=${changedSinceBackup}`);
    if (changedSinceBackup) process.exitCode = 2;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await client.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { USER_FIELDS, TRANSFER_LEGACY_FIELDS, FIELDS_BY_COLLECTION, snapshotGuard };
