'use strict';

const mongoose = require('mongoose');
const {
  ACTIVE_FILTERS,
  COLLECTIONS,
  clean,
  connectSafeTestDb,
  count,
  existingCollections,
  maskMongoUri,
} = require('./_testDbSafety');

function envIsFalse(name) {
  return clean(process.env[name]).toLowerCase() === 'false';
}


function envIsBlank(name) {
  return !clean(process.env[name]);
}

function runtimeEnvChecks() {
  const checks = [];
  const push = (ok, label, detail) => checks.push({ ok, label, detail });

  push(envIsBlank('TELEGRAM_BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN blank', envIsBlank('TELEGRAM_BOT_TOKEN') ? 'disabled' : 'REAL/SET value present');
  push(envIsBlank('BASELINKER_API_TOKEN'), 'legacy BASELINKER_API_TOKEN blank', envIsBlank('BASELINKER_API_TOKEN') ? 'disabled' : 'value present');
  push(envIsBlank('BASELINKER_PRINT_AGENT_TOKEN'), 'BASELINKER_PRINT_AGENT_TOKEN blank', envIsBlank('BASELINKER_PRINT_AGENT_TOKEN') ? 'disabled' : 'value present');
  push(clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY).startsWith('TEST_ONLY_'), 'test-only BASELINKER_TOKEN_ENCRYPTION_KEY', clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY).startsWith('TEST_ONLY_') ? 'TEST_ONLY_*' : 'must start with TEST_ONLY_');
  push(envIsBlank('ALLEGRO_CLIENT_SECRET'), 'ALLEGRO_CLIENT_SECRET blank', envIsBlank('ALLEGRO_CLIENT_SECRET') ? 'disabled' : 'value present');
  push(envIsBlank('OPENAI_API_KEY'), 'OPENAI_API_KEY blank', envIsBlank('OPENAI_API_KEY') ? 'disabled' : 'value present');
  push(envIsBlank('GEMINI_API_KEY'), 'GEMINI_API_KEY blank', envIsBlank('GEMINI_API_KEY') ? 'disabled' : 'value present');
  push(envIsBlank('R2_ACCESS_KEY_ID') && envIsBlank('R2_SECRET_ACCESS_KEY'), 'R2 write credentials blank', (envIsBlank('R2_ACCESS_KEY_ID') && envIsBlank('R2_SECRET_ACCESS_KEY')) ? 'disabled' : 'value present');
  push(envIsBlank('SENTRY_DSN'), 'SENTRY_DSN blank', envIsBlank('SENTRY_DSN') ? 'disabled' : 'value present');
  push(envIsBlank('SENTRY_AUTH_TOKEN') && envIsBlank('SENTRY_AUDIT_AUTH_TOKEN'), 'Sentry auth tokens blank', (envIsBlank('SENTRY_AUTH_TOKEN') && envIsBlank('SENTRY_AUDIT_AUTH_TOKEN')) ? 'disabled' : 'value present');
  push(envIsBlank('REDIS_URL'), 'REDIS_URL blank or use isolated TEST Redis', envIsBlank('REDIS_URL') ? 'disabled' : 'value present');
  push(envIsFalse('KSEF_RECONCILIATION_ENABLED'), 'KSEF_RECONCILIATION_ENABLED=false', clean(process.env.KSEF_RECONCILIATION_ENABLED));
  push(envIsFalse('KSEF_INBOUND_SYNC_ENABLED'), 'KSEF_INBOUND_SYNC_ENABLED=false', clean(process.env.KSEF_INBOUND_SYNC_ENABLED));
  push(envIsFalse('KSEF_OPERATIONS_ENABLED'), 'KSEF_OPERATIONS_ENABLED=false', clean(process.env.KSEF_OPERATIONS_ENABLED));
  push(clean(process.env.JWT_SECRET).startsWith('TEST_ONLY_'), 'test-only JWT_SECRET', clean(process.env.JWT_SECRET).startsWith('TEST_ONLY_') ? 'TEST_ONLY_*' : 'must start with TEST_ONLY_');
  push(Number(process.env.WEB_CONCURRENCY || 1) === 1, 'WEB_CONCURRENCY=1', String(process.env.WEB_CONCURRENCY || 1));
  return checks;
}

async function databaseChecks(db, existing) {
  const specs = [
    ['BaseLinker enabled accounts', COLLECTIONS.baselinkerAccounts, ACTIVE_FILTERS.baselinkerAccounts],
    ['Allegro live/credentialed accounts', COLLECTIONS.allegroAccounts, ACTIVE_FILTERS.allegroAccounts],
    ['Allegro OAuth handoffs', COLLECTIONS.allegroOAuthStates, {}],
    ['KSeF active connections', COLLECTIONS.ksefConnections, ACTIVE_FILTERS.ksefConnections],
    ['KSeF enabled XAdES credentials', COLLECTIONS.ksefXadesCredentials, ACTIVE_FILTERS.ksefXadesCredentials],
    ['KSeF enabled offline certificates', COLLECTIONS.ksefOfflineCertificates, ACTIVE_FILTERS.ksefOfflineCertificates],
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
  ];
  const checks = [];
  for (const [label, collection, filter] of specs) {
    const n = await count(db, existing, collection, filter);
    checks.push({ ok: n === 0, label, detail: String(n) });
  }

  // Required-at-schema credentials cannot be removed from these collections, so
  // the sanitizer replaces them with deterministic inert values. Verify the marker.
  const markerChecks = [
    ['BaseLinker unsanitized token markers', COLLECTIONS.baselinkerAccounts, { tokenHint: { $ne: 'SANITIZED' } }],
    ['KSeF unsanitized token markers', COLLECTIONS.ksefConnections, { tokenHint: { $ne: 'SANITIZED' } }],
    ['KSeF XAdES unsanitized private keys', COLLECTIONS.ksefXadesCredentials, { privateKeyFingerprint: { $not: /^sanitized:/ } }],
    ['KSeF offline unsanitized private keys', COLLECTIONS.ksefOfflineCertificates, { privateKeyFingerprint: { $not: /^sanitized:/ } }],
  ];
  for (const [label, collection, filter] of markerChecks) {
    const n = await count(db, existing, collection, filter);
    checks.push({ ok: n === 0, label, detail: String(n) });
  }
  return checks;
}

function printChecks(title, checks) {
  console.log(`\n${title}`);
  for (const row of checks) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.label}: ${row.detail}`);
  }
}

async function main() {
  const ctx = await connectSafeTestDb();
  try {
    const existing = await existingCollections(ctx.db);
    console.log('\nTEST database safety verification');
    console.log(`host: ${ctx.host}`);
    console.log(`db:   ${ctx.dbName}`);
    console.log(`uri:  ${maskMongoUri(ctx.uri)}`);

    const dbChecks = await databaseChecks(ctx.db, existing);
    const envChecks = runtimeEnvChecks();
    printChecks('Database', dbChecks);
    printChecks('Runtime environment', envChecks);

    const failed = [...dbChecks, ...envChecks].filter((row) => !row.ok);
    if (failed.length) {
      console.error(`\n⛔ SAFE TEST DATABASE: FAIL (${failed.length} failed checks)`);
      process.exitCode = 3;
      return;
    }
    console.log('\n✅ SAFE TEST DATABASE: PASS');
    console.log('External provider credentials/jobs are neutralized and runtime egress secrets are disabled.');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\n⛔ ${error?.message || error}`);
  process.exitCode = Number(error?.exitCode || 1);
});
