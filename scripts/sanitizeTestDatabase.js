'use strict';

const mongoose = require('mongoose');
const {
  ACTIVE_FILTERS,
  COLLECTIONS,
  connectSafeTestDb,
  count,
  existingCollections,
  maskMongoUri,
  requireExecuteConfirmation,
  sanitizedBase64,
  sanitizedEncrypted,
  sanitizedFingerprint,
} = require('./_testDbSafety');

async function forEachDoc(db, existing, collection, projection, fn) {
  if (!existing.has(collection)) return 0;
  let changed = 0;
  const cursor = db.collection(collection).find({}, { projection });
  for await (const row of cursor) {
    await fn(row);
    changed += 1;
  }
  return changed;
}

async function printPlan(db, existing) {
  const rows = [
    ['BaseLinker enabled accounts', COLLECTIONS.baselinkerAccounts, ACTIVE_FILTERS.baselinkerAccounts],
    ['Allegro live/credentialed accounts', COLLECTIONS.allegroAccounts, ACTIVE_FILTERS.allegroAccounts],
    ['Allegro OAuth handoffs', COLLECTIONS.allegroOAuthStates, {}],
    ['KSeF active connections', COLLECTIONS.ksefConnections, ACTIVE_FILTERS.ksefConnections],
    ['KSeF enabled XAdES credentials', COLLECTIONS.ksefXadesCredentials, ACTIVE_FILTERS.ksefXadesCredentials],
    ['KSeF enabled offline certs', COLLECTIONS.ksefOfflineCertificates, ACTIVE_FILTERS.ksefOfflineCertificates],
    ['KSeF auth sessions with tokens', COLLECTIONS.ksefAuthSessions, ACTIVE_FILTERS.ksefAuthSessions],
    ['KSeF active enrollments', COLLECTIONS.ksefEnrollments, ACTIVE_FILTERS.ksefEnrollments],
    ['KSeF active inbound exports', COLLECTIONS.ksefInboundExports, ACTIVE_FILTERS.ksefInboundExports],
    ['KSeF enabled inbound sync states', COLLECTIONS.ksefInboundSync, ACTIVE_FILTERS.ksefInboundSync],
    ['KSeF due reconciliation rows', COLLECTIONS.fiscalSubmissions, ACTIVE_FILTERS.ksefReconciliation],
    ['Commerce outbound jobs', COLLECTIONS.commercePublicationJobs, ACTIVE_FILTERS.commercePublicationJobs],
    ['Telegram enabled destinations', COLLECTIONS.telegramDestinations, ACTIVE_FILTERS.telegramDestinations],
    ['Telegram active publications', COLLECTIONS.telegramPublications, ACTIVE_FILTERS.telegramPublications],
    ['Telegram pending deliveries', COLLECTIONS.telegramNotificationDeliveries, ACTIVE_FILTERS.telegramNotificationDeliveries],
    ['Telegram pending cleanups', COLLECTIONS.telegramMessageCleanups, ACTIVE_FILTERS.telegramMessageCleanups],
    ['BaseLinker active print jobs', COLLECTIONS.baseLinkerPrintJobs, ACTIVE_FILTERS.baseLinkerPrintJobs],
    ['Google link handoffs', COLLECTIONS.googleLinkTokens, {}],
    ['Telegram initData replay rows', COLLECTIONS.telegramInitDataUses, {}],
  ];
  console.log('\nRows that will be neutralized/purged:');
  for (const [label, collection, filter] of rows) {
    const n = await count(db, existing, collection, filter);
    console.log(`  ${String(n).padStart(8)}  ${label}`);
  }
}

async function sanitize(db, existing) {
  const report = {};

  report.baseLinkerAccounts = await forEachDoc(
    db, existing, COLLECTIONS.baselinkerAccounts, { _id: 1 },
    async (row) => db.collection(COLLECTIONS.baselinkerAccounts).updateOne(
      { _id: row._id },
      {
        $set: {
          enabled: false,
          tokenEncrypted: sanitizedEncrypted('baselinker-token', row._id),
          tokenFingerprint: sanitizedFingerprint('baselinker-token', row._id),
          tokenHint: 'SANITIZED',
          lastSyncError: 'test_db_sanitized',
          lastConnectionError: 'test_db_sanitized',
        },
      },
    ),
  );

  if (existing.has(COLLECTIONS.allegroAccounts)) {
    const result = await db.collection(COLLECTIONS.allegroAccounts).updateMany(
      {},
      {
        $set: {
          enabled: false,
          authState: 'authorization_required',
          tokenExpiresAt: null,
          tokenRefreshedAt: null,
          lastSyncError: 'test_db_sanitized',
          lastConnectionError: 'test_db_sanitized',
        },
        $unset: { accessTokenEncrypted: '', refreshTokenEncrypted: '' },
        $inc: { tokenRevision: 1 },
      },
    );
    report.allegroAccounts = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.allegroOAuthStates)) {
    const result = await db.collection(COLLECTIONS.allegroOAuthStates).deleteMany({});
    report.allegroOAuthStatesDeleted = Number(result.deletedCount || 0);
  }

  report.ksefConnections = await forEachDoc(
    db, existing, COLLECTIONS.ksefConnections, { _id: 1 },
    async (row) => db.collection(COLLECTIONS.ksefConnections).updateOne(
      { _id: row._id },
      {
        $set: {
          enabled: false,
          tokenEncrypted: sanitizedEncrypted('ksef-token', row._id),
          tokenFingerprint: sanitizedFingerprint('ksef-token', row._id),
          tokenHint: 'SANITIZED',
          accessTokenEncrypted: null,
          accessTokenValidUntil: null,
          refreshTokenEncrypted: null,
          refreshTokenValidUntil: null,
          lastConnectionError: 'test_db_sanitized',
        },
      },
    ),
  );

  report.ksefXadesCredentials = await forEachDoc(
    db, existing, COLLECTIONS.ksefXadesCredentials, { _id: 1 },
    async (row) => db.collection(COLLECTIONS.ksefXadesCredentials).updateOne(
      { _id: row._id },
      {
        $set: {
          enabled: false,
          certificateBase64: sanitizedBase64('ksef-xades-cert', row._id),
          privateKeyEncrypted: sanitizedEncrypted('ksef-xades-key', row._id),
          privateKeyFingerprint: `sanitized:${sanitizedFingerprint('ksef-xades-key', row._id)}`,
          lastConnectionError: 'test_db_sanitized',
        },
      },
    ),
  );

  report.ksefOfflineCertificates = await forEachDoc(
    db, existing, COLLECTIONS.ksefOfflineCertificates, { _id: 1 },
    async (row) => db.collection(COLLECTIONS.ksefOfflineCertificates).updateOne(
      { _id: row._id },
      {
        $set: {
          enabled: false,
          isDefault: false,
          certificateBase64: sanitizedBase64('ksef-offline-cert', row._id),
          privateKeyEncrypted: sanitizedEncrypted('ksef-offline-key', row._id),
          privateKeyFingerprint: `sanitized:${sanitizedFingerprint('ksef-offline-key', row._id)}`,
        },
      },
    ),
  );

  if (existing.has(COLLECTIONS.ksefAuthSessions)) {
    const result = await db.collection(COLLECTIONS.ksefAuthSessions).deleteMany({});
    report.ksefAuthSessionsDeleted = Number(result.deletedCount || 0);
  }

  if (existing.has(COLLECTIONS.ksefEnrollments)) {
    const result = await db.collection(COLLECTIONS.ksefEnrollments).updateMany(
      {},
      {
        $set: {
          state: 'manual_review',
          privateKeyEncrypted: null,
          lastErrorCode: 'test_db_sanitized',
          lastErrorMessage: 'External enrollment disabled in sanitized TEST database',
        },
      },
    );
    report.ksefEnrollments = Number(result.modifiedCount || 0);
  }

  report.ksefInboundExports = await forEachDoc(
    db, existing, COLLECTIONS.ksefInboundExports, { _id: 1 },
    async (row) => db.collection(COLLECTIONS.ksefInboundExports).updateOne(
      { _id: row._id },
      {
        $set: {
          state: 'manual_review',
          symmetricKeyEncrypted: sanitizedEncrypted('ksef-export-key', row._id),
          initializationVectorEncrypted: sanitizedEncrypted('ksef-export-iv', row._id),
          nextAttemptAt: null,
          leaseUntil: null,
          lastError: {
            code: 'test_db_sanitized',
            message: 'External inbound export disabled in sanitized TEST database',
            httpStatus: null,
            providerCode: '',
            details: null,
          },
        },
      },
    ),
  );

  if (existing.has(COLLECTIONS.ksefInboundSync)) {
    const result = await db.collection(COLLECTIONS.ksefInboundSync).updateMany(
      {},
      { $set: { enabled: false, state: 'idle', nextSyncAt: null, leaseUntil: null } },
    );
    report.ksefInboundSync = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.fiscalSubmissions)) {
    const result = await db.collection(COLLECTIONS.fiscalSubmissions).updateMany(
      ACTIVE_FILTERS.ksefReconciliation,
      {
        $set: {
          'reconciliation.state': 'manual_review',
          'reconciliation.nextAttemptAt': null,
          'reconciliation.leaseUntil': null,
          'reconciliation.lastError': {
            code: 'test_db_sanitized',
            message: 'KSeF reconciliation disabled in sanitized TEST database',
            httpStatus: null,
            providerCode: '',
            details: null,
          },
        },
      },
    );
    report.ksefReconciliation = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.commercePublicationJobs)) {
    const result = await db.collection(COLLECTIONS.commercePublicationJobs).updateMany(
      ACTIVE_FILTERS.commercePublicationJobs,
      {
        $set: {
          state: 'failed',
          lockToken: '',
          lastErrorCode: 'test_db_sanitized',
          lastError: 'External commerce publication disabled in sanitized TEST database',
          completedAt: new Date(),
        },
      },
    );
    report.commercePublicationJobs = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.telegramDestinations)) {
    const result = await db.collection(COLLECTIONS.telegramDestinations).updateMany(
      {},
      { $set: { enabled: false, canPost: false, canEdit: false, canDelete: false, healthCode: 'test_db_sanitized' } },
    );
    report.telegramDestinations = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.telegramPublications)) {
    const result = await db.collection(COLLECTIONS.telegramPublications).updateMany(
      ACTIVE_FILTERS.telegramPublications,
      {
        $set: {
          status: 'failed',
          nextAttemptAt: null,
          leaseUntil: null,
          lastError: { code: 'test_db_sanitized', message: 'Telegram publication disabled in TEST database' },
        },
      },
    );
    report.telegramPublications = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.telegramNotificationDeliveries)) {
    const result = await db.collection(COLLECTIONS.telegramNotificationDeliveries).updateMany(
      ACTIVE_FILTERS.telegramNotificationDeliveries,
      {
        $set: {
          status: 'skipped',
          nextAttemptAt: null,
          leaseUntil: null,
          skipReason: 'test_db_sanitized',
        },
      },
    );
    report.telegramNotificationDeliveries = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.telegramMessageCleanups)) {
    const result = await db.collection(COLLECTIONS.telegramMessageCleanups).updateMany(
      ACTIVE_FILTERS.telegramMessageCleanups,
      {
        $set: {
          status: 'manual_required',
          nextAttemptAt: null,
          leaseUntil: null,
          lastError: { code: 'test_db_sanitized', message: 'Telegram cleanup disabled in TEST database' },
        },
      },
    );
    report.telegramMessageCleanups = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.baseLinkerPrintJobs)) {
    const result = await db.collection(COLLECTIONS.baseLinkerPrintJobs).updateMany(
      ACTIVE_FILTERS.baseLinkerPrintJobs,
      {
        $set: {
          status: 'expired',
          leaseUntil: null,
          completedAt: new Date(),
          lastError: 'test_db_sanitized',
        },
      },
    );
    report.baseLinkerPrintJobs = Number(result.modifiedCount || 0);
  }

  if (existing.has(COLLECTIONS.googleLinkTokens)) {
    const result = await db.collection(COLLECTIONS.googleLinkTokens).deleteMany({});
    report.googleLinkTokensDeleted = Number(result.deletedCount || 0);
  }

  if (existing.has(COLLECTIONS.telegramInitDataUses)) {
    const result = await db.collection(COLLECTIONS.telegramInitDataUses).deleteMany({});
    report.telegramInitDataUsesDeleted = Number(result.deletedCount || 0);
  }

  return report;
}

async function main() {
  const ctx = await connectSafeTestDb();
  try {
    const existing = await existingCollections(ctx.db);
    const execute = requireExecuteConfirmation(ctx.dbName);
    console.log('\nTEST database external-credential sanitizer');
    console.log(execute ? '⚠️  EXECUTE MODE' : '🔍 DRY-RUN — no writes');
    console.log(`host: ${ctx.host}`);
    console.log(`db:   ${ctx.dbName}`);
    console.log(`uri:  ${maskMongoUri(ctx.uri)}`);
    await printPlan(ctx.db, existing);

    if (!execute) {
      console.log('\nDRY-RUN complete. Nothing was changed.');
      console.log('Execute only after you verify the DB name above:');
      console.log(`node scripts/sanitizeTestDatabase.js --execute --confirm-db=${ctx.dbName} --confirm-action=SANITIZE_EXTERNAL_CREDENTIALS`);
      return;
    }

    console.log('\nSanitizing copied integration/auth state...');
    const report = await sanitize(ctx.db, existing);
    console.log('\n✅ Sanitizer finished. Running safety verification is mandatory before starting the backend.');
    for (const [name, n] of Object.entries(report)) {
      console.log(`  ${String(n).padStart(8)}  ${name}`);
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\n⛔ ${error?.message || error}`);
  process.exitCode = Number(error?.exitCode || 1);
});
