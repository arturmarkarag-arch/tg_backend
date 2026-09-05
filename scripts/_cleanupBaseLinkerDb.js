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

const BaseLinkerOrderCache = require('../models/BaseLinkerOrderCache');
const BaseLinkerOrderSnapshot = require('../models/BaseLinkerOrderSnapshot');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const BaseLinkerPrintJob = require('../models/BaseLinkerPrintJob');
const AppSetting = require('../models/AppSetting');

const SETTINGS_KEYS = Object.freeze([
  'baselinker.queueSettings.v1',
  'baselinker.orderCache.v2',
  'baselinker.journal.v1',
]);

const MODELS = Object.freeze([
  ['BaseLinkerOrderCache', BaseLinkerOrderCache, 'latest BaseLinker order mirror/cache'],
  ['BaseLinkerOrderSnapshot', BaseLinkerOrderSnapshot, 'immutable BaseLinker raw snapshots'],
  ['BaseLinkerPickingOrder', BaseLinkerPickingOrder, 'warehouse picking/local workflow'],
  ['BaseLinkerPrintJob', BaseLinkerPrintJob, 'queued/finished BaseLinker label jobs'],
  ['BaseLinkerPrintAgent', BaseLinkerPrintAgent, 'ephemeral Print Agent registrations'],
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
    if (testLoaded) {
      fail('REFUSE PROD cleanup: TEST_ENV_LOADED is present. This process is wired to the TEST environment.');
    }
    if (hostAllowed(uriHost)) {
      fail(
        `REFUSE PROD cleanup: Mongo host ${uriHost || 'unknown'} matches TEST guard suffix ${allowedSuffix()}.`
      );
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
    fail(
      `REFUSE PROD cleanup after connect: connected Mongo host ${connectedHost || 'unknown'} matches TEST guard suffix ${allowedSuffix()}.`
    );
  }
}

function assertExecutionConfirmation(mode, dbName) {
  if (!EXECUTE) return;

  const confirmedDb = argValue('--confirm-db');
  if (!confirmedDb || confirmedDb !== dbName) {
    fail(
      `REFUSE EXECUTE: pass the exact connected database name: --confirm-db=${dbName}`
    );
  }

  if (mode === 'PROD') {
    const productionAck = argValue('--confirm-production');
    if (productionAck !== 'WIPE_BASELINKER_PROD') {
      fail(
        'REFUSE PROD EXECUTE: additionally pass --confirm-production=WIPE_BASELINKER_PROD'
      );
    }
  }
}

async function existingCollections(db) {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
}

async function countModelRows(existing, model) {
  const collection = model.collection.collectionName;
  if (!existing.has(collection)) return 0;
  return model.collection.countDocuments({});
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
  for (const [name, model, description] of MODELS) {
    const collection = model.collection.collectionName;
    const count = await countModelRows(existing, model);
    console.log(`  ${String(count).padStart(8)}  ${collection.padEnd(34)} ${description}`);
  }

  const settingsCount = await countSettings(existing);
  console.log(`\nAppSetting rows to clear: ${settingsCount}`);
  for (const key of SETTINGS_KEYS) console.log(`  - ${key}`);

  console.log('\nAfter wipe, indexes are synchronized against the current SINGLE-ACCOUNT schemas.');
  console.log('BaseLinker queue statuses must be configured again after cleanup.');
}

async function executeCleanup(db, existing) {
  const deleted = {};

  for (const [name, model] of MODELS) {
    const collection = model.collection.collectionName;
    if (!existing.has(collection)) {
      deleted[name] = 0;
      continue;
    }
    const result = await model.collection.deleteMany({});
    deleted[name] = Number(result.deletedCount || 0);
  }

  const settingsCollection = AppSetting.collection.collectionName;
  let deletedSettings = 0;
  if (existing.has(settingsCollection)) {
    const result = await AppSetting.collection.deleteMany({ key: { $in: SETTINGS_KEYS } });
    deletedSettings = Number(result.deletedCount || 0);
  }

  // Empty collections are the safest moment to replace any retired accountScope
  // compound indexes with the current single-account indexes.
  for (const [, model] of MODELS) {
    await model.syncIndexes();
  }

  return { deleted, deletedSettings };
}

async function verifyEmpty(db) {
  const existing = await existingCollections(db);
  const remaining = [];
  for (const [name, model] of MODELS) {
    const count = await countModelRows(existing, model);
    if (count !== 0) remaining.push(`${name}=${count}`);
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
    for (const [name, count] of Object.entries(result.deleted)) {
      console.log(`  deleted ${String(count).padStart(8)}  ${name}`);
    }
    console.log(`  deleted ${String(result.deletedSettings).padStart(8)}  BaseLinker AppSetting rows`);
    console.log('  indexes synchronized to current single-account schemas');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

module.exports = { runCleanup };
