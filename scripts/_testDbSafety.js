'use strict';

const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');

function loadRepoEnvIfNeeded() {
  if (process.env.MONGODB_URI) return;
  if (process.env.NODE_ENV === 'production') return;
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
  } catch (_) { /* optional local convenience only */ }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function argValue(name) {
  const prefix = `${name}=`;
  const row = process.argv.slice(2).find((item) => String(item).startsWith(prefix));
  return row ? String(row).slice(prefix.length) : '';
}

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function fail(message, exitCode = 2) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function maskMongoUri(uri) {
  return clean(uri).replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
}

function assertSafeTestArm() {
  if (clean(process.env.NODE_ENV).toLowerCase() === 'production') {
    fail('REFUSE: NODE_ENV=production. Test DB sanitizer/audit may not run in production mode.');
  }
  if (clean(process.env.SAFE_TEST_DB) !== 'YES_I_KNOW_THIS_IS_TEST') {
    fail('REFUSE: set SAFE_TEST_DB=YES_I_KNOW_THIS_IS_TEST in this shell.');
  }
  const expectedDb = clean(process.env.SAFE_TEST_DB_NAME);
  if (!expectedDb) {
    fail('REFUSE: SAFE_TEST_DB_NAME is required and must equal the exact restored TEST database name.');
  }
  if (/(^|[-_.])(prod|production)([-_.]|$)/i.test(expectedDb)) {
    fail(`REFUSE: SAFE_TEST_DB_NAME=${expectedDb} looks like a production database name.`);
  }
  const uri = clean(process.env.MONGODB_URI);
  if (!uri) fail('REFUSE: MONGODB_URI is not configured.');
  return { uri, expectedDb };
}

async function connectSafeTestDb() {
  loadRepoEnvIfNeeded();
  const { uri, expectedDb } = assertSafeTestArm();
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
    socketTimeoutMS: 30_000,
  });
  const db = mongoose.connection.db;
  const actualDb = clean(db?.databaseName);
  if (!actualDb || actualDb !== expectedDb) {
    await mongoose.disconnect().catch(() => {});
    fail(
      `REFUSE: connected database is ${actualDb || 'unknown'}, but SAFE_TEST_DB_NAME=${expectedDb}. ` +
      `uri=${maskMongoUri(uri)}`,
    );
  }
  if (/(^|[-_.])(prod|production)([-_.]|$)/i.test(actualDb)) {
    await mongoose.disconnect().catch(() => {});
    fail(`REFUSE: connected database name ${actualDb} looks production-like.`);
  }
  return { db, dbName: actualDb, host: clean(mongoose.connection.host), uri };
}

async function existingCollections(db) {
  return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
}

async function count(db, existing, collection, filter = {}) {
  if (!existing.has(collection)) return 0;
  return db.collection(collection).countDocuments(filter);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sanitizedEncrypted(label, id) {
  const seed = crypto.createHash('sha512').update(`TEST_DB_SANITIZED:${label}:${id}`).digest();
  return {
    version: 1,
    iv: seed.subarray(0, 12).toString('base64'),
    tag: seed.subarray(12, 28).toString('base64'),
    ciphertext: seed.subarray(28).toString('base64'),
  };
}

function sanitizedFingerprint(label, id) {
  return sha256(`TEST_DB_SANITIZED:${label}:${id}`);
}

function sanitizedBase64(label, id) {
  return Buffer.from(`TEST_DB_SANITIZED:${label}:${id}`, 'utf8').toString('base64');
}

function requireExecuteConfirmation(dbName) {
  if (!hasArg('--execute')) return false;
  const confirmedDb = argValue('--confirm-db');
  const confirmedAction = argValue('--confirm-action');
  if (confirmedDb !== dbName) {
    fail(`REFUSE EXECUTE: pass --confirm-db=${dbName}`);
  }
  if (confirmedAction !== 'SANITIZE_EXTERNAL_CREDENTIALS') {
    fail('REFUSE EXECUTE: pass --confirm-action=SANITIZE_EXTERNAL_CREDENTIALS');
  }
  return true;
}

const ACTIVE_FILTERS = Object.freeze({
  baselinkerAccounts: { enabled: true },
  allegroAccounts: {
    $or: [
      { enabled: true },
      { authState: 'connected' },
      { accessTokenEncrypted: { $exists: true } },
      { refreshTokenEncrypted: { $exists: true } },
    ],
  },
  ksefConnections: {
    $or: [
      { enabled: true },
      { accessTokenEncrypted: { $exists: true, $ne: null } },
      { refreshTokenEncrypted: { $exists: true, $ne: null } },
    ],
  },
  ksefXadesCredentials: { enabled: true },
  ksefOfflineCertificates: { enabled: true },
  ksefAuthSessions: {
    $or: [
      { accessTokenEncrypted: { $exists: true, $ne: null } },
      { refreshTokenEncrypted: { $exists: true, $ne: null } },
    ],
  },
  ksefEnrollments: { state: { $in: ['prepared', 'submitted', 'processing', 'ambiguous_submit'] } },
  ksefInboundExports: { state: { $in: ['prepared', 'running', 'processing', 'retry_wait', 'ambiguous_submit'] } },
  ksefInboundSync: { enabled: true },
  ksefReconciliation: {
    provider: 'ksef',
    $and: [
      {
        $or: [
          { state: { $in: ['submitted', 'processing'] } },
          { state: 'accepted', receipt: null },
          { state: 'accepted', 'receipt.receivedAt': { $exists: false } },
          { state: 'error', 'providerData.sessionReferenceNumber': { $exists: true, $nin: ['', null] } },
        ],
      },
      {
        $or: [
          { 'reconciliation.state': { $exists: false } },
          { 'reconciliation.state': { $in: ['idle', 'pending', 'running', 'retry_wait'] } },
        ],
      },
    ],
  },
  commercePublicationJobs: { state: { $in: ['reserved', 'sending', 'pending', 'unknown'] } },
  telegramDestinations: { $or: [{ enabled: true }, { canPost: true }, { canEdit: true }, { canDelete: true }] },
  telegramPublications: { status: { $in: ['queued', 'sending', 'retry_wait', 'unknown'] } },
  telegramNotificationDeliveries: { status: { $in: ['pending', 'sending', 'retry_wait'] } },
  telegramMessageCleanups: { status: { $in: ['pending', 'sending', 'retry_wait'] } },
  baseLinkerPrintJobs: { status: { $in: ['pending', 'claimed', 'printing', 'submitted'] } },
});

const COLLECTIONS = Object.freeze({
  baselinkerAccounts: 'baselinkeraccounts',
  allegroAccounts: 'allegroaccounts',
  allegroOAuthStates: 'allegrooauthstates',
  ksefConnections: 'ksefconnections',
  ksefXadesCredentials: 'ksefxadescredentials',
  ksefOfflineCertificates: 'ksefofflinecertificates',
  ksefAuthSessions: 'ksefxadesauthsessions',
  ksefEnrollments: 'ksefcertificateenrollments',
  ksefInboundExports: 'ksefinboundexports',
  ksefInboundSync: 'ksefinboundsyncstates',
  fiscalSubmissions: 'fiscalsubmissions',
  commercePublicationJobs: 'commercepublicationjobs',
  telegramDestinations: 'telegramdestinations',
  telegramPublications: 'telegrampublications',
  telegramNotificationDeliveries: 'telegramnotificationdeliveries',
  telegramMessageCleanups: 'telegrammessagecleanups',
  baseLinkerPrintJobs: 'baselinkerprintjobs',
  googleLinkTokens: 'googlelinktokens',
  telegramInitDataUses: 'telegraminitdatauses',
});

module.exports = {
  ACTIVE_FILTERS,
  COLLECTIONS,
  argValue,
  assertSafeTestArm,
  clean,
  connectSafeTestDb,
  count,
  existingCollections,
  fail,
  hasArg,
  loadRepoEnvIfNeeded,
  maskMongoUri,
  requireExecuteConfirmation,
  sanitizedBase64,
  sanitizedEncrypted,
  sanitizedFingerprint,
};
