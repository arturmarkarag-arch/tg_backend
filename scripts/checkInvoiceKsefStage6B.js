'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); }

const model = read('models/KsefInboundExport.js');
const syncModel = read('models/KsefInboundSyncState.js');
const policy = read('services/invoices/ksef/inboundExportPolicy.js');
const archive = read('services/invoices/ksef/inboundExportArchive.js');
const exportsSvc = read('services/invoices/ksef/inboundExports.js');
const sync = read('services/invoices/ksef/inboundSync.js');
const docs = read('services/invoices/ksef/inboundDocuments.js');
const scheduler = read('services/invoices/ksef/inboundScheduler.js');
const routes = read('routes/invoices.js');
const index = read('index.js');
const errors = read('utils/errors.js');
const provider = read('services/invoices/fiscalProviders/ksef.js');
const doc = read('docs/invoices/INVOICE-KSEF-STAGE6.md');
const pure = read('tests/invoiceKsefStage6B.pure.js');
const pkg = JSON.parse(read('package.json'));

check('durable export model exists with encrypted AES material hidden from normal reads',
  model.includes('KsefInboundExportSchema') &&
  model.includes('symmetricKeyEncrypted') && model.includes('select: false') &&
  model.includes('initializationVectorEncrypted') &&
  model.includes("enum: ['prepared', 'running', 'processing', 'retry_wait', 'complete', 'ambiguous_submit', 'manual_review']"));

check('export identity and provider reference indexes prevent duplicate jobs/references',
  model.includes("index({ exportId: 1 }, { unique: true })") &&
  model.includes("index({ exportKey: 1 }, { unique: true })") &&
  model.includes("index({ environment: 1, referenceNumber: 1 }, { unique: true, sparse: true })"));

check('Stage 6 sync state explicitly parks while export owns the cursor',
  syncModel.includes("'export_wait'") &&
  sync.includes("if (sync.state === 'export_wait') throw appError('ksef_inbound_export_active')"));

check('Stage 6B uses current TarGz compression and PermanentStorage Subject2 filters',
  policy.includes("const EXPORT_COMPRESSION = 'TarGz'") &&
  exportsSvc.includes("compressionType: EXPORT_COMPRESSION") &&
  exportsSvc.includes("filters: buildMetadataFilters") &&
  exportsSvc.includes("subjectType: SUBJECT_TYPE"));

check('export AES key and IV are generated locally and encrypted at rest before provider POST',
  exportsSvc.includes('crypto.randomBytes(32)') &&
  exportsSvc.includes('crypto.randomBytes(16)') &&
  exportsSvc.includes("encryptSecret(symmetricKey.toString('base64'), exportId, 'inbound_export_key')") &&
  exportsSvc.indexOf('KsefInboundExport.create') < exportsSvc.indexOf("'/invoices/exports'"));

check('public-key encryption uses SymmetricKeyEncryption and publicKeyId with one rotation recovery',
  exportsSvc.includes("getPublicKey(row.environment, 'SymmetricKeyEncryption'") &&
  exportsSvc.includes('rsaOaepSha256Encrypt(key, publicKey.publicKey)') &&
  exportsSvc.includes('publicKeyId: publicKey.publicKeyId') &&
  exportsSvc.includes('invalidatePublicKeys(row.environment)'));

check('ambiguous POST result is never blindly replayed',
  exportsSvc.includes("state: 'ambiguous_submit'") &&
  exportsSvc.includes('beforeReference && kind ===') &&
  exportsSvc.includes("state: 'manual_review'") &&
  !exportsSvc.slice(exportsSvc.indexOf('if (beforeReference && kind')).split('return { ok: false',1)[0].includes('submitExport('));

check('known reference recovery is GET-only status polling',
  exportsSvc.includes('`/invoices/exports/${encodeURIComponent(row.referenceNumber)}`') &&
  exportsSvc.includes("if (!row.referenceNumber)") &&
  exportsSvc.includes("if (parsed.code === 100)") &&
  exportsSvc.includes("if (parsed.code !== 200)"));

check('status parser requires part encrypted/plain hash+size identities and HWM',
  policy.includes('part.partHash') && policy.includes('part.encryptedPartHash') &&
  policy.includes('part.partSize') && policy.includes('part.encryptedPartSize') &&
  policy.includes('pkg.permanentStorageHwmDate') &&
  policy.includes('pkg.lastPermanentStorageDate'));

check('truncated export continues from LastPermanentStorageDate, otherwise stable HWM',
  policy.includes('pkg.isTruncated ? asDate(pkg.lastPermanentStorageDate) : asDate(pkg.permanentStorageHwmDate)') &&
  policy.includes("if (pkg.isTruncated && next.getTime() <= from.getTime()) return null"));

check('successful zero-invoice/zero-part export advances HWM without attempting TAR extraction',
  exportsSvc.includes('if (pkg.invoiceCount === 0 && pkg.parts.length === 0)') &&
  exportsSvc.includes("empty: true") &&
  exportsSvc.includes("if (!pkg.parts.length) throw appError('ksef_inbound_export_package_invalid')"));

check('signed download URL is provider-only HTTPS without bearer token forwarding',
  archive.includes("url.protocol !== 'https:'") &&
  archive.includes('url.username || url.password') &&
  archive.includes("url.hostname === 'localhost'") &&
  archive.includes("fetch(safeUrl, { method: 'GET'") &&
  !archive.slice(archive.indexOf('async function downloadExportPart'), archive.indexOf('function parseOctal')).includes('Authorization'));

check('every export part verifies encrypted hash+size before AES-256-CBC decrypt',
  archive.includes("'ksef_inbound_export_encrypted_part_mismatch'") &&
  archive.includes("crypto.createDecipheriv('aes-256-cbc', key, iv)") &&
  archive.indexOf("'ksef_inbound_export_encrypted_part_mismatch'") < archive.indexOf("crypto.createDecipheriv('aes-256-cbc'"));

check('every decrypted part verifies provider plain hash+size after decrypt',
  archive.includes("'ksef_inbound_export_plain_part_mismatch'") &&
  archive.indexOf("crypto.createDecipheriv('aes-256-cbc'") < archive.indexOf("'ksef_inbound_export_plain_part_mismatch'"));

check('large package is spooled sequentially instead of concatenated into one RAM buffer',
  exportsSvc.includes("path.join(dir, 'package.tar.gz')") &&
  exportsSvc.includes('await fs.promises.appendFile(archivePath, plain') &&
  !exportsSvc.includes('Buffer.concat(decryptedParts'));

check('TarGz extraction is streaming and rejects traversal/checksum bombs',
  archive.includes('fs.createReadStream(filePath).pipe(gunzip)') &&
  archive.includes('tarHeaderInfo') &&
  archive.includes('storedChecksum !== computed') &&
  archive.includes("fullName.startsWith('/')") &&
  archive.includes("fullName.includes('\\\\')") &&
  archive.includes("part === '..'") &&
  archive.includes('MAX_EXTRACTED_BYTES'));

check('_metadata.json is required exactly once before XML ingestion',
  exportsSvc.includes("path.basename(name).toLowerCase() !== '_metadata.json'") &&
  exportsSvc.includes("if (metadata) throw appError('ksef_inbound_export_metadata_duplicate')") &&
  exportsSvc.includes("if (!metadata || !Array.isArray(metadata.invoices))"));

check('current invoiceHash is canonical with fileHash only as compatibility fallback',
  docs.includes('item.invoiceHash || item.fileHash') &&
  policy.includes('item.invoiceHash || item.fileHash') &&
  errors.includes('SHA-256 invoiceHash'));

check('bulk metadata upsert is chunked and preserves provider-neutral inbound identity',
  docs.includes('async function upsertInboundExportMetadataBatch') &&
  docs.includes('chunkSize = 500') &&
  docs.includes('InboundFiscalDocument.bulkWrite') &&
  docs.includes("provider: 'ksef'") &&
  docs.includes("sourceRole: 'buyer'"));

check('bulk metadata ingestion does not select raw artifact XML into high-volume memory',
  !docs.slice(docs.indexOf('async function upsertInboundExportMetadataBatch'), docs.indexOf('function publicInboundDocument')).includes("+artifact.contentBase64"));

check('XML entries are matched by SHA-256 metadata identity, not trusted filename',
  exportsSvc.includes('const hash = sha256Base64(bytes)') &&
  exportsSvc.includes('const metadataBucket = hashIndex.get(hash)') &&
  exportsSvc.includes('const rowBucket = rowsByHash.get(hash)') &&
  exportsSvc.includes('filenameKsefNumber(name)'));

check('export XML reuses immutable artifact storage and XSD policy from Stage 6A',
  exportsSvc.includes('storeExportArtifact(row, bytes)') &&
  docs.includes('async function storeExportArtifact') &&
  docs.includes('buildArtifactPayload'));

const nonEmptyIntegrityStart = exportsSvc.indexOf('if (xmlEntries !== batch.uniqueMetadataCount');
const nonEmptyCompletion = exportsSvc.indexOf("state: 'complete'", nonEmptyIntegrityStart);
const nonEmptyCursorAdvance = exportsSvc.indexOf("state: 'idle', cursorFrom: nextCursor", nonEmptyCompletion);
check('cursor advances only after full metadata/XML package integrity succeeds',
  nonEmptyIntegrityStart >= 0 &&
  exportsSvc.indexOf('const nextCursor = continuationFromPackage', nonEmptyIntegrityStart) > nonEmptyIntegrityStart &&
  nonEmptyCompletion > nonEmptyIntegrityStart &&
  nonEmptyCursorAdvance > nonEmptyCompletion);

check('metadata truncation automatically hands control to durable export without partial cursor advance',
  sync.includes('if (parsed.isTruncated)') &&
  sync.includes('queueInboundExportForSync') &&
  sync.includes('exportQueued: true') &&
  sync.includes("state: 'export_wait'") === false /* state is set by export service */ &&
  exportsSvc.includes("state: 'export_wait'"));

check('distributed scheduler has separate metadata/export/document lanes with long leader lease',
  scheduler.includes('claimInboundSync') &&
  scheduler.includes('claimInboundExport') &&
  scheduler.includes('claimInboundDocument') &&
  scheduler.includes('processInboundExportClaim') &&
  scheduler.includes('Math.max(30 * 60_000, 20 * TICK_MS)'));

check('manual high-volume export route is queue-only and cannot directly call provider',
  routes.includes("router.post('/ksef/inbound-syncs/:syncId/export'") &&
  routes.includes('queueKsefInboundExport') &&
  !routes.slice(routes.indexOf("router.post('/ksef/inbound-syncs/:syncId/export'"), routes.indexOf("router.get('/ksef/inbound-documents'")).includes('ksefRequest('));

check('export list/detail routes are admin-only and filter validation fails closed',
  routes.includes('router.use(adminOnly)') &&
  routes.includes("router.get('/ksef/inbound-exports'") &&
  routes.includes("router.get('/ksef/inbound-exports/:exportId'") &&
  exportsSvc.includes("throw appError('legal_entity_id_invalid')") &&
  exportsSvc.includes('normalizeEnvironment(environment)') &&
  exportsSvc.includes("throw appError('ksef_inbound_export_state_invalid')"));

check('critical boot indexes include durable export jobs',
  index.includes("require('./models/KsefInboundExport')") &&
  index.includes('db.ksefinboundexports.getIndexes()'));

check('part download/network retry is safe after known export reference',
  exportsSvc.includes("code === 'ksef_inbound_export_part_download_failed'") &&
  exportsSvc.includes("code === 'ksef_inbound_export_part_timeout'") &&
  exportsSvc.includes("state: row.referenceNumber ? 'processing' : 'retry_wait'"));

check('Stage 6B pure gate covers AES, status/HWM, signed URL and TarGz traversal',
  pure.includes("crypto.createCipheriv('aes-256-cbc'") &&
  pure.includes('decryptExportPart') &&
  pure.includes('parseExportStatus') &&
  pure.includes('forEachTarGzEntry') &&
  pure.includes("'../evil.xml'") &&
  !pure.includes('mongoose'));

check('package exposes Stage 6B pure/static gates without adding a Stage 6B dependency',
  pkg.scripts?.['test:invoice:stage6b'] === 'node tests/invoiceKsefStage6B.pure.js' &&
  pkg.scripts?.['test:invoice:stage6b:static'] === 'node scripts/checkInvoiceKsefStage6B.js');

check('Stage 6B errors are explicit for encryption, TAR, metadata, XML and HWM failures',
  errors.includes('ksef_inbound_export_encrypted_part_mismatch') &&
  errors.includes('ksef_inbound_export_tar_checksum_invalid') &&
  errors.includes('ksef_inbound_export_metadata_conflict') &&
  errors.includes('ksef_inbound_export_xml_count_mismatch') &&
  errors.includes('ksef_inbound_export_hwm_invalid'));

check('Stage 6 documentation describes implemented high-volume export rather than deferred placeholder',
  doc.includes('Stage 6B') &&
  doc.includes('POST /invoices/exports') &&
  doc.includes('TarGz') &&
  doc.includes('_metadata.json') &&
  !doc.includes('не входить у Stage 6A'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 6B static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 6B static contract passed: ${checks.length}/${checks.length}`);
