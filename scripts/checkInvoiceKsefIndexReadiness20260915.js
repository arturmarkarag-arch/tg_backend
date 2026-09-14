'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const index = read('index.js');
const app = read('app.js');
const invoiceRoutes = read('routes/invoices.js');
const writeState = read('services/invoices/invoiceKsefWriteState.js');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['critical sync reconciles schema indexes and verifies zero remaining drift',
    index.includes('await model.syncIndexes()')
      && index.includes('await model.diffIndexes()')
      && index.includes("error.code = 'critical_index_drift'")],
  ['global critical failures still enter global maintenance',
    index.includes("failureScope = 'global'")
      && index.includes("else enterMaintenance(issue)")],
  ['Invoice/KSeF index failures degrade only Invoice/KSeF writes',
    index.includes("failureScope === 'invoice_ksef'")
      && index.includes('blockInvoiceKsefWrites(issue)')
      && index.includes("failureScope: 'invoice_ksef'")],
  ['Invoice/KSeF API remains readable but blocks mutations while degraded',
    invoiceRoutes.includes('router.use(invoiceKsefWriteGuard)')
      && writeState.includes("if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();")
      && writeState.includes("error: 'invoice_ksef_read_only'")],
  ['Invoice/KSeF failure does not stop Telegram or non-KSeF schedulers',
    index.includes('if (!isMaintenanceActive()) initBot(TELEGRAM_BOT_TOKEN)')
      && index.includes('startBaseLinkerQueueScheduler();')
      && index.includes('startAllegroOrderScheduler();')
      && index.includes('if (!areInvoiceKsefWritesBlocked()) {')],
  ['KSeF startup recovery is skipped while Invoice/KSeF writes are blocked',
    index.includes("console.warn('[invoice-ksef] write domain disabled")
      && index.includes("await recoverStaleKsefLeases({ source: 'startup' });")],
  ['health exposes domain degradation without converting it to global maintenance',
    app.includes("status: maintenance.active ? 'maintenance' : (invoiceKsef.blocked ? 'degraded' : 'ok')")
      && app.includes('invoiceKsef: { blocked: invoiceKsef.blocked')],
  ['outbound Invoice/KSeF identity has its own boot-critical gate',
    index.includes("key: 'invoice_ksef_outbound'")],
  ['outbound invoice identity models are boot-critical',
    ['LegalEntity', 'Invoice', 'InvoiceSnapshot', 'FiscalSubmission'].every((name) => index.includes(`models/${name}`))],
  ['KSeF credential/auth/certificate models are boot-critical',
    ['KsefConnection', 'KsefXadesCredential', 'KsefXadesAuthSession', 'KsefCertificateEnrollment', 'KsefOfflineCertificate']
      .every((name) => index.includes(`models/${name}`))],
  ['existing inbound and correction gates are Invoice/KSeF-scoped',
    index.includes("key: 'invoice_ksef_inbound'")
      && index.includes("key: 'invoice_ksef_corrections'")
      && (index.match(/failureScope: 'invoice_ksef'/g) || []).length >= 3],
  ['production start preloads Sentry before Express 5 is imported',
    pkg.scripts?.start === 'node --import ./instrument.js index.js'],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log(`PASS ${name}`);
  else { failed += 1; console.error(`FAIL ${name}`); }
}
if (failed) {
  console.error(`Invoice/KSeF index readiness: FAIL (${failed}/${checks.length})`);
  process.exit(1);
}
console.log(`Invoice/KSeF index readiness: ${checks.length}/${checks.length} PASS`);
