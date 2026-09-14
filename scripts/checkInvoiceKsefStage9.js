'use strict';

const fs = require('fs');
function read(path) { return fs.readFileSync(path, 'utf8'); }
let passed = 0;
function check(name, condition) {
  if (!condition) { console.error(`FAIL ${name}`); process.exitCode = 1; return; }
  passed += 1; console.log(`PASS ${name}`);
}

const model = read('models/KsefOperationalEvent.js');
const telemetry = read('services/invoices/ksef/operationalTelemetry.js');
const policy = read('services/invoices/ksef/operationalPolicy.js');
const operations = read('services/invoices/ksef/operations.js');
const scheduler = read('services/invoices/ksef/operationalScheduler.js');
const http = read('services/invoices/ksef/http.js');
const keys = read('services/invoices/ksef/publicKeys.js');
const reconcile = read('services/invoices/ksef/reconciliationScheduler.js');
const inbound = read('services/invoices/ksef/inboundScheduler.js');
const routes = read('routes/invoices.js');
const index = read('index.js');
const errors = read('utils/errors.js');
const packageJson = JSON.parse(read('package.json'));

check('durable KSeF operational event model exists', model.includes("mongoose.model('KsefOperationalEvent'") && model.includes("kind:"));
check('operational events have bounded TTL retention', model.includes('expireAfterSeconds: 180 * 24 * 60 * 60'));
check('operational event payload excludes legal XML/token/private-key fields by schema', !model.includes('contentBase64') && !model.includes('privateKey') && !model.includes('tokenEncrypted'));
check('telemetry writes are best effort and cannot fail fiscal operation', telemetry.includes('Diagnostics must never break the fiscal operation') && telemetry.includes('recordOperationalEventBestEffort'));
check('HTTP helper records 429 timeout unavailable auth and 5xx telemetry', http.includes('recordHttpFailure') && telemetry.includes("code === 'ksef_rate_limited'") && telemetry.includes("code === 'ksef_api_timeout'") && telemetry.includes('httpStatus >= 500'));
check('operational path strips query secrets and redacts identifiers', policy.includes("split('?')[0]") && policy.includes("'{objectId}'") && policy.includes("'{providerId}'"));
check('readiness reports schedulers manual review stale leases credentials and telemetry', operations.includes('staleLeases') && operations.includes('manualReview') && operations.includes('telemetryLastHour') && operations.includes('offlineCertificates') && operations.includes('xadesCredentials'));
check('readiness is local and live provider probe is separate', routes.includes("'/ksef/ops/readiness'") && routes.includes("'/ksef/ops/probe'") && operations.includes("ksefRequest(env, '/rate-limits'"));
check('live probe uses only public rate-limit and public-key endpoints', operations.includes("'/rate-limits'") && operations.includes('loadPublicKeys(env, { force: true })'));
check('public-key cache exposes metadata only', keys.includes('getPublicKeyCacheStatus') && !operations.includes('certificateBase64'));
check('ops queue aggregates all durable KSeF manual-review state machines', ['fiscal_submission','inbound_sync','inbound_document','inbound_export','certificate_enrollment','technical_correction'].every(v => operations.includes(v)));
check('retry policy refuses ambiguous export/enrollment blind replay', policy.includes("case 'inbound_export'") && policy.includes("row.state === 'manual_review'") && policy.includes("case 'certificate_enrollment'") && policy.includes("row.state !== 'ambiguous_submit'"));
check('restart recovery requeues GET-only leases', operations.includes("'reconciliation.state': 'pending'") && operations.includes("state: 'idle', nextSyncAt: now") && operations.includes("artifactState: 'pending_fetch'"));
check('restart recovery never blindly replays an in-flight export POST', operations.includes("state: 'ambiguous_submit'") && operations.includes('ksef_inbound_export_restart_ambiguous') && policy.includes("return clean(referenceNumber, 256) ? 'processing' : 'ambiguous_submit'"));
check('restart recovery resumes export status polling when provider reference exists', operations.includes("referenceNumber: { $gt: '' }") && operations.includes("state: 'processing', nextAttemptAt: now"));
check('transient XAdES/token caches have explicit cleanup', operations.includes('KsefXadesAuthSession.deleteMany') && operations.includes('expiredTokenConnectionCachesCleared'));
check('operational telemetry indexes are non-boot-critical', index.includes('[ksef-operations] telemetry index sync failed') && index.includes("require('./models/KsefOperationalEvent').syncIndexes()"));
check('startup stale lease recovery runs before KSeF schedulers', index.indexOf("recoverStaleKsefLeases({ source: 'startup' })") > 0 && index.indexOf("recoverStaleKsefLeases({ source: 'startup' })") < index.indexOf('startKsefReconciliationScheduler()'));
check('operational scheduler starts with backend and can be disabled', index.includes('startKsefOperationalScheduler()') && scheduler.includes("KSEF_OPERATIONS_ENABLED || 'true'") && scheduler.includes("=== 'false'"));
check('operational scheduler is distributed-leader protected', scheduler.includes("runAsSchedulerLeader('ksef-operational-maintenance'"));
check('existing KSeF schedulers persist scheduler errors', reconcile.includes('recordOperationalEventBestEffort') && inbound.includes('recordOperationalEventBestEffort'));
check('ops endpoints remain behind global admin-only invoice router', routes.indexOf('router.use(adminOnly)') > 0 && routes.indexOf("router.get('/ksef/ops/readiness'") > routes.indexOf('router.use(adminOnly)'));
check('ops API exposes readiness queue events safe retry probe recovery and cleanup', ["/ksef/ops/readiness","/ksef/ops/issues","/ksef/ops/events","/ksef/ops/probe","/ksef/ops/recover-stale-leases","/ksef/ops/cleanup"].every(v => routes.includes(v)) && routes.includes("/ksef/ops/issues/:kind/:id/retry"));
check('Stage 9 operational API errors are explicit and fail-closed', ['ksef_ops_id_invalid','ksef_ops_issue_kind_invalid','ksef_ops_retry_not_safe','ksef_ops_severity_invalid'].every(v => errors.includes(v)));
check('Stage 9 has executable static and pure npm gates', packageJson.scripts['test:invoice:stage9:static'] === 'node scripts/checkInvoiceKsefStage9.js' && packageJson.scripts['test:invoice:stage9'] === 'node tests/invoiceKsefStage9.pure.js');

if (!process.exitCode) console.log(`Invoice KSeF Stage 9 static contract passed: ${passed}/25`);
