'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const pkg = JSON.parse(read('package.json'));
const model = read('models/InboundFiscalDocument.js');
const syncModel = read('models/KsefInboundSyncState.js');
const policy = read('services/invoices/ksef/inboundPolicy.js');
const auth = read('services/invoices/ksef/inboundAuth.js');
const documents = read('services/invoices/ksef/inboundDocuments.js');
const sync = read('services/invoices/ksef/inboundSync.js');
const scheduler = read('services/invoices/ksef/inboundScheduler.js');
const contract = read('services/invoices/fiscalProviders/contract.js');
const provider = read('services/invoices/fiscalProviders/ksef.js');
const routes = read('routes/invoices.js');
const index = read('index.js');
const errors = read('utils/errors.js');
const stage3 = read('scripts/checkInvoiceKsefStage3.js');
const stage4 = read('scripts/checkInvoiceKsefStage4.js');
const pure = read('tests/invoiceKsefStage6.pure.js');
const doc = read('docs/invoices/INVOICE-KSEF-STAGE6.md');

check('Stage 6 inbound model, sync, policy, auth, document, scheduler and tests exist',
  exists('models/InboundFiscalDocument.js') &&
  exists('models/KsefInboundSyncState.js') &&
  exists('services/invoices/ksef/inboundPolicy.js') &&
  exists('services/invoices/ksef/inboundAuth.js') &&
  exists('services/invoices/ksef/inboundDocuments.js') &&
  exists('services/invoices/ksef/inboundSync.js') &&
  exists('services/invoices/ksef/inboundScheduler.js') &&
  exists('tests/invoiceKsefStage6.pure.js') &&
  exists('tests/inboundFiscalDocumentModel.test.js'));

check('InboundFiscalDocument is provider-neutral and separate from outbound Invoice',
  model.includes("provider: { type: String, required: true") &&
  model.includes('providerDocumentId:') &&
  model.includes('providerArtifactHashBase64:') &&
  model.includes('providerStoredAt:') &&
  model.includes("sourceRole: { type: String, required: true, enum: ['seller', 'buyer', 'third', 'authorized', 'other']") &&
  !model.includes('ksefNumber:') && !model.includes('subjectType:') && !model.includes('permanentStorageDate:'));

check('Inbound identity dedup is unique by provider/legal entity/environment/provider document id',
  model.includes('{ provider: 1, legalEntityId: 1, environment: 1, providerDocumentId: 1 }') &&
  model.includes('{ unique: true }'));

check('raw inbound artifact is immutable-style Base64 and hidden from routine reads',
  model.includes('contentBase64: { type: String, required: true, select: false }') &&
  model.includes("encoding: { type: String, required: true, enum: ['base64']") &&
  model.includes('providerHashBase64:') && model.includes('sha256Hex:'));

check('KSeF sync state is durable Subject2-only with cursor, page and lease state',
  syncModel.includes("subjectType: { type: String, required: true, enum: ['Subject2']") &&
  syncModel.includes('cursorFrom:') && syncModel.includes('activeWindowTo:') &&
  syncModel.includes('pageOffset:') && syncModel.includes('lastPermanentStorageHwmDate:') &&
  syncModel.includes('leaseUntil:'));

check('KSeF inbound sync is unique per legal entity/environment/Subject2',
  syncModel.includes('{ legalEntityId: 1, environment: 1, subjectType: 1 }') && syncModel.includes('{ unique: true }'));

check('Stage 6 rate/window policy is conservative and explicit',
  policy.includes("const SUBJECT_TYPE = 'Subject2'") &&
  policy.includes('const PAGE_SIZE = 250') &&
  policy.includes('const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000') &&
  policy.includes('const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000') &&
  policy.includes('const PAGE_CONTINUE_MS = 4 * 60 * 1000') &&
  policy.includes('const FETCH_TICK_MS = 90 * 1000'));

check('metadata query uses PermanentStorage HWM restriction for Subject2',
  policy.includes("dateType: 'PermanentStorage'") &&
  policy.includes('restrictToPermanentStorageHwmDate: true') &&
  policy.includes('subjectType: SUBJECT_TYPE'));

check('metadata pageOffset is a page number and advances by one, not by pageSize',
  sync.includes('/invoices/query/metadata?sortOrder=Asc&pageOffset=${pageOffset}&pageSize=${pageSize}') &&
  sync.includes('pageOffset: pageOffset + 1') &&
  !sync.includes('pageOffset: pageOffset + pageSize'));

check('metadata response requires hasMore, isTruncated and PermanentStorage HWM',
  sync.includes("typeof body.hasMore !== 'boolean'") &&
  sync.includes("typeof body.isTruncated !== 'boolean'") &&
  sync.includes('body.permanentStorageHwmDate') &&
  sync.includes("throw appError('ksef_inbound_hwm_missing')"));

check('truncated >10k metadata result hands off to durable Stage 6B export without partial cursor advancement',
  sync.includes('if (parsed.isTruncated)') &&
  sync.includes('queueInboundExportForSync') &&
  sync.includes('exportQueued: true') &&
  sync.includes('imported: { created: 0, updated: 0, conflicts: 0 }') &&
  read('services/invoices/ksef/inboundExports.js').includes("state: 'export_wait'"));

check('HWM behind persisted cursor is a safe no-progress cycle only on an empty first page',
  sync.includes('PermanentStorage HWM may temporarily trail an already persisted cursor') &&
  sync.includes('if (sync.activeWindowTo || parsed.hasMore || parsed.invoices.length)') &&
  sync.includes("noProgress: 'permanent_storage_hwm_before_cursor'"));

check('inbound auth supports system-token connection and XAdES while validating context binding',
  auth.includes("authMethod === 'token_connection'") && auth.includes("authMethod === 'xades'") &&
  auth.includes('legalEntityId') && auth.includes('environment') &&
  auth.includes('getAccessToken') && auth.includes('getXadesAccessToken'));

check('KSeF number is provider-normalized before path/header use',
  policy.includes('function normalizeKsefNumber') &&
  policy.includes('/^(?=.{35,36}$)[0-9A-Z]+(?:-[0-9A-Z]+){3}$/') &&
  documents.includes('normalizeKsefNumber(item.ksefNumber)') &&
  pure.includes('X-Evil: 1'));

check('metadata identity prefers current KSeF invoiceHash and only keeps fileHash as compatibility fallback',
  documents.includes('normalizeHashBase64(item.invoiceHash || item.fileHash)') &&
  errors.includes('коректного SHA-256 invoiceHash'));

check('KSeF metadata maps into generic inbound identifiers instead of leaking provider fields into core model',
  documents.includes("provider: 'ksef'") &&
  documents.includes("sourceRole: 'buyer'") &&
  documents.includes('providerDocumentId: ksefNumber') &&
  documents.includes('providerArtifactHashBase64: invoiceHashBase64') &&
  documents.includes('providerStoredAt: asDate(item.permanentStorageDate)'));

check('same provider document with a different fileHash is manual-review fail-closed',
  documents.includes('normalizeHashBase64(document.providerArtifactHashBase64) !== invoiceHashBase64') &&
  documents.includes("document.artifactState = 'manual_review'") &&
  documents.includes("document.fetch.state = 'manual_review'"));

check('individual invoice hydration uses the KSeF number and preserves raw response bytes',
  documents.includes('`/invoices/ksef/${encodeURIComponent(row.providerDocumentId)}`') &&
  documents.includes("responseType: 'buffer'") &&
  documents.includes('Buffer.isBuffer(bytes)'));

check('inbound XML requires x-ms-meta-hash and triple SHA-256 agreement before storage',
  documents.includes("response.headers.get('x-ms-meta-hash')") &&
  documents.includes('effectiveProviderHash !== computedBase64 || metadataHash !== computedBase64') &&
  documents.includes("throw appError('ksef_inbound_artifact_hash_mismatch'"));

check('stored artifact keeps exact raw bytes and local download rehashes all identities',
  documents.includes("contentBase64: bytes.toString('base64')") &&
  documents.includes('size: bytes.length') &&
  documents.includes("Buffer.from(document.artifact.contentBase64, 'base64')") &&
  documents.includes('computed !== document.artifact.hashBase64') &&
  documents.includes('computed !== normalizeHashBase64(document.artifact.providerHashBase64)') &&
  documents.includes('computed !== normalizeHashBase64(document.providerArtifactHashBase64)'));

check('FA(3) inbound XML is XSD validated, while unsupported schema/validator availability is never misreported valid',
  documents.includes('if (isFa3Xml(xml))') &&
  documents.includes('await validateFa3Xml(xml)') &&
  documents.includes("validatorUnavailable ? 'unsupported' : 'invalid'") &&
  documents.includes("state: 'unsupported', schemaName: 'non-FA(3)'") &&
  model.includes('schemaName: { type: String') &&
  model.includes('issues: { type: [mongoose.Schema.Types.Mixed]') &&
  documents.includes("schema: value.validation.schemaName || ''") &&
  documents.includes('errors: Array.isArray(value.validation.issues)') &&
  documents.includes("artifactState = 'stored_warning'"));

check('manual fetch endpoint is queue-only and cannot bypass distributed provider scheduler rate control',
  documents.includes('async function requestInboundDocumentFetch') &&
  documents.includes("'fetch.state': 'pending'") &&
  !documents.slice(documents.indexOf('async function requestInboundDocumentFetch'), documents.indexOf('async function getInboundXml')).includes('ksefRequest(') &&
  routes.includes('requestKsefInboundDocumentFetch(req.params.documentId)'));

check('routine list filters validate LegalEntity, KSeF environment and artifact state',
  documents.includes("throw appError('legal_entity_id_invalid')") &&
  documents.includes('filter.environment = normalizeEnvironment(environment)') &&
  documents.includes("throw appError('ksef_inbound_document_state_invalid')"));

check('scheduler is distributed-leader guarded and has metadata/export/XML lanes',
  scheduler.includes("runAsSchedulerLeader('ksef-inbound-sync'") &&
  scheduler.includes("const TICK_MS = Math.max(90_000") &&
  scheduler.includes("const sync = await claimInboundSync('', new Date())") &&
  scheduler.includes("const exportJob = await claimInboundExport('', new Date())") &&
  scheduler.includes("const document = await claimInboundDocument('', new Date())") &&
  scheduler.includes("KSEF_INBOUND_SYNC_ENABLED || 'true'"));

check('critical startup indexes protect inbound dedup, durable cursor and export-job invariants',
  index.includes("key: 'invoice_ksef_inbound'") &&
  index.includes("require('./models/InboundFiscalDocument')") &&
  index.includes("require('./models/KsefInboundSyncState')") &&
  index.includes("require('./models/KsefInboundExport')") &&
  index.includes('provider+legalEntityId+environment+providerDocumentId'));

check('fiscal provider contract makes RECEIVE explicit for live adapters',
  contract.includes("RECEIVE: 'invoice.receive'") &&
  contract.includes("capabilities[CAPABILITIES.RECEIVE]") &&
  contract.includes('must implement receive()') &&
  contract.includes('receive: definition.receive || null'));

check('KSeF provider enables RECEIVE through Stage 6 sync without contaminating outbound Invoice Core',
  provider.includes('[CAPABILITIES.RECEIVE]: true') &&
  provider.includes('receive: ({ syncId }) => runInboundSync(syncId)') &&
  provider.includes("stage6: { inbound: 'Subject2 PermanentStorage HWM'") &&
  !read('services/invoices/invoiceService.js').includes('InboundFiscalDocument'));

check('Stage 6 HTTP surface remains admin-only and exposes sync/document lifecycle routes',
  routes.includes('router.use(adminOnly)') &&
  routes.includes("router.get('/ksef/inbound-syncs'") &&
  routes.includes("router.post('/ksef/inbound-syncs'") &&
  routes.includes("router.patch('/ksef/inbound-syncs/:syncId'") &&
  routes.includes("router.post('/ksef/inbound-syncs/:syncId/run'") &&
  routes.includes("router.post('/ksef/inbound-syncs/:syncId/reset-cursor'") &&
  routes.includes("router.get('/ksef/inbound-documents'") &&
  routes.includes("router.get('/ksef/inbound-documents/:documentId'") &&
  routes.includes("router.post('/ksef/inbound-documents/:documentId/fetch'") &&
  routes.includes("router.get('/ksef/inbound-documents/:documentId/xml'"));

check('XML download is local-only byte output with nosniff/hash/validation headers',
  routes.includes("res.set('Content-Type', 'application/xml')") &&
  routes.includes("res.set('X-Content-Type-Options', 'nosniff')") &&
  routes.includes("res.set('X-KSeF-Invoice-SHA256', result.sha256Hex)") &&
  documents.slice(documents.indexOf('async function getInboundXml')).includes('contentBase64') &&
  !documents.slice(documents.indexOf('async function getInboundXml')).includes('ksefRequest('));

check('Stage 3/4 gates preserve outbound-only historical invariants while allowing Stage 6 inbound adapter',
  stage3.includes('Stage 3 online transport still defaults offlineMode=false') &&
  stage3.includes('InboundFiscalDocument') &&
  stage4.includes('Stage 4 reconciliation remains GET-only') &&
  stage4.includes('inbound'));

check('Stage 6 pure test covers window/HWM/filter/hash/raw-byte/retry/sync-key policy without mongoose',
  pure.includes("assert.equal(SUBJECT_TYPE, 'Subject2')") &&
  pure.includes('restrictToPermanentStorageHwmDate: true') &&
  pure.includes('hash must use exact raw bytes including BOM/CRLF') &&
  pure.includes('retryAfterMs') && pure.includes('syncKey') &&
  !pure.includes('mongoose'));

check('package exposes Stage 6 pure/static gates with no new runtime dependency',
  pkg.scripts?.['test:invoice:stage6'] === 'node tests/invoiceKsefStage6.pure.js' &&
  pkg.scripts?.['test:invoice:stage6:static'] === 'node scripts/checkInvoiceKsefStage6.js');

check('Stage 6 fail-closed errors are explicit',
  errors.includes('ksef_inbound_export_active') &&
  errors.includes('ksef_inbound_artifact_hash_mismatch') &&
  errors.includes('ksef_inbound_local_artifact_hash_mismatch') &&
  errors.includes('ksef_inbound_document_state_invalid'));

check('Stage 6 documentation includes the implemented Stage 6B export/high-volume lane',
  doc.includes('Stage 6B') && doc.includes('POST /invoices/exports') && doc.includes('TarGz') &&
  !doc.includes('не входить у Stage 6A'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 6 static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 6 static contract passed: ${checks.length}/${checks.length}`);
