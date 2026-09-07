'use strict';

const mongoose = require('mongoose');
const {
  assertEnvUriAllowed,
  assertConnectedHostAllowed,
  hostAllowed,
  mongoHostFromUri,
  maskMongoUri,
  allowedSuffix,
} = require('../utils/liveE2EDbGuard');

const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const BaseLinkerPrintJob = require('../models/BaseLinkerPrintJob');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');
const AppSetting = require('../models/AppSetting');

const SETTINGS_KEYS = Object.freeze([
  'baselinker.queueSettings.v1',
  'baselinker.orderIndex.v1',
  'baselinker.orderIndex.v3',
  // Retired state keys are included so this script can clean a deployment that
  // is upgrading from the old full-order mirror/journal architecture.
  'baselinker.orderCache.v2',
  'baselinker.journal.v1',
]);

const MODELS = Object.freeze([
  ['BaseLinkerOrderIndex', BaseLinkerOrderIndex, 'minimal Intake order_id index'],
  ['BaseLinkerPickingOrder', BaseLinkerPickingOrder, 'warehouse picking/local workflow'],
  ['BaseLinkerPrintJob', BaseLinkerPrintJob, 'queued/finished BaseLinker label jobs'],
  ['BaseLinkerPrintAgent', BaseLinkerPrintAgent, 'ephemeral Print Agent registrations'],
  ['BaseLinkerProductImageCache', BaseLinkerProductImageCache, 'non-PII worker product image cache'],
]);

const LEGACY_COLLECTIONS = Object.freeze([
  ['baselinkerordercaches', 'RETIRED full BaseLinker order mirror/cache'],
  ['baselinkerordersnapshots', 'RETIRED raw BaseLinker order snapshots'],
]);

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const argValue = (prefix) => {
  const row = argv.find((item) => item.startsWith(`${prefix}=`));
  return row ? row.slice(prefix.length + 1) : '';
};

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function assertModeBeforeConnect(mode, uri) {
  const testLoaded = Boolean(process.env.TEST_ENV_LOADED);
  const uriHost = mongoHostFromUri(uri);

  if (mode === 'TEST') {
    if (!testLoaded) {
      fail(
        'REFUSE TEST cleanup: TEST_ENV_LOADED is missing. Run only through ' +
        '`node -r ../dev-use-test-db.js scripts/cleanupBaseLinkerDb.TEST.js`.'
      );
    }
    assertEnvUriAllowed(uri);
    return;
  }

  if (mode === 'PROD') {
    if (testLoaded) fail('REFUSE PROD cleanup: TEST_ENV_LOADED is present. This process is wired to the TEST environment.');
    if (hostAllowed(uriHost)) {
      fail(`REFUSE PROD cleanup: Mongo host ${uriHost || 'unknown'} matches TEST guard suffix ${allowedSuffix()}.`);
    }
    return;
  }

  fail(`Unknown cleanup mode: ${mode}`);
}

function assertModeAfterConnect(mode) {
  const connectedHost = String(mongoose.connection.host || '').toLowerCase();
  if (mode === 'TEST') {
    assertConnectedHostAllowed(connectedHost);
    return;
  }
  if (mode === 'PROD' && hostAllowed(connectedHost)) {
    fail(`REFUSE PROD cleanup after connect: connected Mongo host ${connectedHost || 'unknown'} matches TEST guard suffix ${allowedSuffix()}.`);
  }
}

function assertExecutionConfirmation(mode, dbName) {
  if (!EXECUTE) return;
  const confirmedDb = argValue('--confirm-db');
  if (!confirmedDb || confirmedDb !== dbName) fail(`REFUSE EXECUTE: pass the exact connected database name: --confirm-db=${dbName}`);
  if (mode === 'PROD' && argValue('--confirm-production') !== 'WIPE_BASELINKER_PROD') {
    fail('REFUSE PROD EXECUTE: additionally pass --confirm-production=WIPE_BASELINKER_PROD');
  }
}

async function existingCollections(db) {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
}

async function countCollection(existing, db, collection) {
  if (!existing.has(collection)) return 0;
  return db.collection(collection).countDocuments({});
}

async function countModelRows(existing, model) {
  return countCollection(existing, mongoose.connection.db, model.collection.collectionName);
}

async function countSettings(existing) {
  const collection = AppSetting.collection.collectionName;
  if (!existing.has(collection)) return 0;
  return AppSetting.collection.countDocuments({ key: { $in: SETTINGS_KEYS } });
}

async function printPlan(mode, db, existing) {
  console.log(`\nBaseLinker DB cleanup · ${mode}`);
  console.log(`${EXECUTE ? '⚠️  EXECUTE' : '🔍 DRY-RUN — no writes'}`);
  console.log(`host: ${mongoose.connection.host}`);
  console.log(`db:   ${db.databaseName}`);
  console.log(`uri:  ${maskMongoUri(process.env.MONGODB_URI)}\n`);

  console.log('Collections to clear:');
  for (const [, model, description] of MODELS) {
    const collection = model.collection.collectionName;
    const count = await countModelRows(existing, model);
    console.log(`  ${String(count).padStart(8)}  ${collection.padEnd(34)} ${description}`);
  }
  for (const [collection, description] of LEGACY_COLLECTIONS) {
    const count = await countCollection(existing, db, collection);
    console.log(`  ${String(count).padStart(8)}  ${collection.padEnd(34)} ${description}`);
  }

  const settingsCount = await countSettings(existing);
  console.log(`\nAppSetting rows to clear: ${settingsCount}`);
  for (const key of SETTINGS_KEYS) console.log(`  - ${key}`);

  console.log('\nAfter wipe, indexes are synchronized against the current account-scoped BaseLinker schemas.');
  console.log('BaseLinker queue statuses must be configured again after cleanup.');
}

async function executeCleanup(db, existing) {
  const deleted = {};

  for (const [name, model] of MODELS) {
    const collection = model.collection.collectionName;
    if (!existing.has(collection)) { deleted[name] = 0; continue; }
    const result = await db.collection(collection).deleteMany({});
    deleted[name] = Number(result.deletedCount || 0);
  }
  for (const [collection] of LEGACY_COLLECTIONS) {
    if (!existing.has(collection)) { deleted[collection] = 0; continue; }
    const result = await db.collection(collection).deleteMany({});
    deleted[collection] = Number(result.deletedCount || 0);
  }

  const settingsCollection = AppSetting.collection.collectionName;
  let deletedSettings = 0;
  if (existing.has(settingsCollection)) {
    const result = await AppSetting.collection.deleteMany({ key: { $in: SETTINGS_KEYS } });
    deletedSettings = Number(result.deletedCount || 0);
  }

  for (const [, model] of MODELS) await model.syncIndexes();
  return { deleted, deletedSettings };
}

async function verifyEmpty(db) {
  const existing = await existingCollections(db);
  const remaining = [];
  for (const [name, model] of MODELS) {
    const count = await countModelRows(existing, model);
    if (count !== 0) remaining.push(`${name}=${count}`);
  }
  for (const [collection] of LEGACY_COLLECTIONS) {
    const count = await countCollection(existing, db, collection);
    if (count !== 0) remaining.push(`${collection}=${count}`);
  }
  const settings = await countSettings(existing);
  if (settings !== 0) remaining.push(`BaseLinkerAppSettings=${settings}`);
  if (remaining.length) fail(`Cleanup verification failed: ${remaining.join(', ')}`, 3);
}

async function runCleanup(mode) {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) fail('MONGODB_URI is not configured. Nothing was changed.');
  assertModeBeforeConnect(mode, uri);

  try {
    await mongoose.connect(uri);
    assertModeAfterConnect(mode);
    const db = mongoose.connection.db;
    const existing = await existingCollections(db);
    await printPlan(mode, db, existing);
    assertExecutionConfirmation(mode, db.databaseName);

    if (!EXECUTE) {
      console.log('\nDRY-RUN complete. Nothing was changed.');
      console.log(`To execute, re-run with --execute --confirm-db=${db.databaseName}` +
        (mode === 'PROD' ? ' --confirm-production=WIPE_BASELINKER_PROD' : '') + '.');
      return;
    }

    console.log('\nExecuting BaseLinker-only cleanup...');
    const result = await executeCleanup(db, existing);
    await verifyEmpty(db);

    console.log('\n✅ BaseLinker cleanup complete and verified.');
    for (const [name, count] of Object.entries(result.deleted)) console.log(`  deleted ${String(count).padStart(8)}  ${name}`);
    console.log(`  deleted ${String(result.deletedSettings).padStart(8)}  BaseLinker AppSetting rows`);
    console.log('  indexes synchronized to current account-scoped BaseLinker schemas');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

module.exports = { runCleanup };
