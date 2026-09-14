'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const pkg = JSON.parse(read('package.json'));
const model = read('models/FiscalSubmission.js');
const http = read('services/invoices/ksef/http.js');
const online = read('services/invoices/ksef/online.js');
const submissions = read('services/invoices/ksef/submissions.js');
const policy = read('services/invoices/ksef/reconciliationPolicy.js');
const scheduler = read('services/invoices/ksef/reconciliationScheduler.js');
const contract = read('services/invoices/fiscalProviders/contract.js');
const adapter = read('services/invoices/fiscalProviders/ksef.js');
const routes = read('routes/invoices.js');
const index = read('index.js');
const errors = read('utils/errors.js');
const pure = read('tests/invoiceKsefStage4.pure.js');

check('Stage 4 lifecycle files exist', exists('services/invoices/ksef/reconciliationPolicy.js') && exists('services/invoices/ksef/reconciliationScheduler.js') && exists('tests/invoiceKsefStage4.pure.js'));
check('FiscalSubmission stores verified UPO separately from submitted invoice artifact', model.includes('ReceiptSchema') && model.includes('contentBase64') && model.includes("encoding: { type: String, required: true, enum: ['base64']") && model.includes('providerHashBase64') && model.includes('receipt: { type: ReceiptSchema'));
check('FiscalSubmission has durable reconciliation state, attempts, nextAttemptAt and leaseUntil', model.includes('ReconciliationSchema') && model.includes("'retry_wait'") && model.includes("'manual_review'") && model.includes('nextAttemptAt') && model.includes('leaseUntil'));
check('routine submission serialization strips both outbound invoice XML and UPO XML', submissions.includes('const { content, ...artifactMeta }') && submissions.includes('const { contentBase64, ...receiptMeta }'));
check('HTTP core supports byte-exact raw XML responses without JSON coercion', http.includes("responseType = 'json'") && http.includes("responseType === 'buffer'") && http.includes('response.arrayBuffer()') && http.includes("responseType === 'text' ? text") && http.includes("'application/xml,text/xml"));
check('online API implements session status/list, invoice status and per-invoice UPO GET', online.includes('getSessionStatus') && online.includes('listSessionInvoices') && online.includes('buildSessionInvoicesRequest') && policy.includes("'x-continuation-token': String(continuationToken)") && policy.includes("pageSize: '1000'") && !policy.includes("params.set('continuationToken'") && online.includes('/upo`') && online.includes("responseType: 'buffer'"));
check('ambiguous send recovery matches immutable invoice SHA-256 and never re-sends', submissions.includes('recoverAmbiguousInvoiceReference') && submissions.includes('selectInvoiceHashMatches') && submissions.includes('artifact?.hashBase64') && submissions.includes('recoveredFromSessionAt') && submissions.includes('AMBIGUOUS_RECONCILE_DELAY_MS = 120_000'));
const reconcileStart = submissions.indexOf('async function recoverAmbiguousInvoiceReference');
const reconcileEnd = submissions.indexOf('async function submitInvoiceToKsef');
const reconcileSlice = submissions.slice(reconcileStart, reconcileEnd);
check('reconciliation section is GET-only and contains no invoice send/open-session mutation', !reconcileSlice.includes('sendInvoice(') && !reconcileSlice.includes('openOnlineSessionWithKeyRecovery(') && !reconcileSlice.includes('closeOnlineSession('));
check('terminal session without hash match fails closed into manual review', submissions.includes('isTerminalSessionStatus(sessionStatus)') && submissions.includes('ksef_submission_not_found_in_session') && submissions.includes("state: 'manual_review'"));
check('multiple same-hash matches fail closed into manual review', submissions.includes('matches.length > 1') && submissions.includes('ksef_submission_ambiguous_matches'));
check('UPO storage hashes original bytes, requires provider x-ms-meta-hash and stores Base64 byte-exact content', online.includes("x-ms-meta-hash") && submissions.includes("Buffer.isBuffer(result.content)") && submissions.includes("crypto.createHash('sha256').update(bytes)") && submissions.includes("contentBase64: bytes.toString('base64')") && submissions.includes('ksef_upo_hash_missing') && submissions.includes('ksef_upo_hash_mismatch') && submissions.includes('upoIntegrityVerified: true'));
check('provider-neutral fiscal contract exposes getUpo only when UPO capability is live', contract.includes('capabilities[CAPABILITIES.UPO]') && contract.includes('definition.getUpo') && adapter.includes('[CAPABILITIES.UPO]: true') && adapter.includes('getUpo:'));
check('Stage 4 reconciliation remains GET-only and later inbound stays outside reconciliation path', !reconcileSlice.includes('offlineMode') && !reconcileSlice.includes('runInboundSync') && !reconcileSlice.includes('InboundFiscalDocument'));
check('claimed reconciliation preserves its lease through status/UPO work', submissions.includes("reconciliationWasRunning") && submissions.includes("else if (!reconciliationWasRunning) queueReconciliation") && scheduler.includes("'reconciliation.state': 'running'"));
check('scheduler uses distributed leadership plus per-row lease and bounded batch', scheduler.includes("runAsSchedulerLeader('ksef-submission-reconcile'") && scheduler.includes('leaseUntil') && scheduler.includes('BATCH_SIZE') && scheduler.includes('Math.min(5') && scheduler.includes('Math.max(30_000') && scheduler.includes('retry_wait'));
check('scheduler starts with backend but can be explicitly disabled', index.includes('startKsefReconciliationScheduler()') && scheduler.includes("KSEF_RECONCILIATION_ENABLED || 'true'") && scheduler.includes("=== 'false'"));
check('admin-only API exposes explicit reconcile and raw verified UPO download', routes.includes('router.use(adminOnly)') && routes.includes("'/:id/fiscal/ksef/reconcile'") && routes.includes("'/:id/fiscal/ksef/upo'") && routes.includes("'application/xml; charset=utf-8'") && routes.includes('res.send(result.content)') && routes.includes('X-KSeF-UPO-SHA256'));
check('Stage 4 errors cover ambiguous recovery and UPO integrity', errors.includes('ksef_submission_ambiguous_matches') && errors.includes('ksef_submission_not_found_in_session') && errors.includes('ksef_upo_hash_missing') && errors.includes('ksef_upo_hash_mismatch'));
check('pure Stage 4 test exercises hash match, terminal session, Retry-After and byte-exact XML buffer mode', pure.includes('selectInvoiceHashMatches') && pure.includes('isTerminalSessionStatus') && pure.includes('retryAfterMs') && pure.includes('buildSessionInvoicesRequest') && pure.includes("nextPage.headers['x-continuation-token']") && pure.includes("responseType: 'buffer'") && pure.includes('assert.deepEqual(bufferResponse.body, rawUpo)'));
check('package exposes Stage 4 pure and static gates', pkg.scripts?.['test:invoice:stage4'] === 'node tests/invoiceKsefStage4.pure.js' && pkg.scripts?.['test:invoice:stage4:static'] === 'node scripts/checkInvoiceKsefStage4.js');
check('policy keeps recovery deterministic and dependency-free', policy.includes('selectInvoiceHashMatches') && policy.includes('retryDelayMs') && !policy.includes('mongoose') && !policy.includes('fetch('));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 4 static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 4 static contract passed: ${checks.length}/${checks.length}`);
