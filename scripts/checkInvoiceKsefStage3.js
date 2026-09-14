'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const xsdSmoke = read('tests/invoiceKsefStage3.xsd.js');
const connection = read('models/KsefConnection.js');
const submission = read('models/FiscalSubmission.js');
const config = read('services/invoices/ksef/config.js');
const secrets = read('services/invoices/ksef/secretStore.js');
const cryptoCode = read('services/invoices/ksef/crypto.js');
const http = read('services/invoices/ksef/http.js');
const keys = read('services/invoices/ksef/publicKeys.js');
const auth = read('services/invoices/ksef/auth.js');
const fa3 = read('services/invoices/ksef/fa3.js');
const xsd = read('services/invoices/ksef/xsdValidator.js');
const online = read('services/invoices/ksef/online.js');
const submissions = read('services/invoices/ksef/submissions.js');
const adapter = read('services/invoices/fiscalProviders/ksef.js');
const routes = read('routes/invoices.js');
const invoiceService = read('services/invoices/invoiceService.js');

check('Stage 3 KSeF models exist', exists('models/KsefConnection.js') && exists('models/FiscalSubmission.js'));
check('KSeF credentials are encrypted at rest and never modeled as plaintext', secrets.includes("aes-256-gcm") && secrets.includes('KSEF_CREDENTIAL_ENCRYPTION_KEY') && !connection.includes('token: { type: String'));
check('credential master key fails closed below 32 bytes', secrets.includes("Buffer.byteLength(raw, 'utf8') < 32"));
check('TEST/DEMO/PROD API v2 environments are explicit', config.includes('api-test.ksef.mf.gov.pl/v2') && config.includes('api-demo.ksef.mf.gov.pl/v2') && config.includes('api.ksef.mf.gov.pl/v2'));
check('FA(3) online form code is explicit', config.includes("systemCode: 'FA (3)'") && config.includes("schemaVersion: '1-0E'") && config.includes("value: 'FA'"));
check('current KSeF public-key usages and publicKeyId are honored', config.includes('KsefTokenEncryption') && config.includes('SymmetricKeyEncryption') && keys.includes('publicKeyId') && auth.includes('publicKeyId: publicKey.publicKeyId') && online.includes('publicKeyId: key.publicKeyId'));
check('rotated KSeF public key 21470 is one-retry recovered', auth.includes("=== '21470'") && auth.includes('invalidatePublicKeys') && online.includes('openOnlineSessionWithKeyRecovery'));
check('token auth uses challenge and RSA-OAEP/SHA-256', auth.includes("'/auth/challenge'") && auth.includes("'/auth/ksef-token'") && auth.includes('`${token}|${timestampMs}`') && cryptoCode.includes('RSA_PKCS1_OAEP_PADDING') && cryptoCode.includes("oaepHash: 'sha256'"));
check('access/refresh tokens are encrypted and refresh path exists', connection.includes('accessTokenEncrypted') && connection.includes('refreshTokenEncrypted') && auth.includes("'/auth/token/refresh'"));
check('invoice encryption is AES-256-CBC with plaintext/encrypted SHA-256 hashes', cryptoCode.includes("aes-256-cbc") && cryptoCode.includes('invoiceHash') && cryptoCode.includes('encryptedInvoiceHash'));
check('FA(3) generator is provider-local and conservative', fa3.includes('FA3_NAMESPACE') && fa3.includes('ksef_stage3_currency_not_supported') && fa3.includes('ksef_invoice_type_not_supported') && fa3.includes("new Set(['23', '8', '5'])"));
check('XSD validation is pinned, offline-capable and fail-closed', pkg.dependencies?.['@ksefuj/validator'] === '0.3.0' && xsd.includes("import('@ksefuj/validator')") && xsd.includes('enableXsdValidation: true') && xsd.includes('enableSemanticValidation: false') && xsd.includes('ksef_xsd_validation_failed'));
check('XSD validator dependency is locked with its WASM runtime and has a real smoke test', lock.packages?.['']?.dependencies?.['@ksefuj/validator'] === '0.3.0' && lock.packages?.['node_modules/@ksefuj/validator']?.version === '0.3.0' && lock.packages?.['node_modules/libxml2-wasm']?.version === '0.7.1' && pkg.overrides?.['libxml2-wasm'] === '0.7.1' && xsdSmoke.includes('validateFa3Xml(xml)') && xsdSmoke.includes('WariantFormularza>99') && pkg.scripts?.['test:invoice:stage3']?.includes('invoiceKsefStage3.xsd.js'));
check('online session uses encrypted key + IV and sends encrypted invoice', online.includes("'/sessions/online'") && online.includes('encryptedSymmetricKey') && online.includes('initializationVector') && online.includes('encryptedInvoiceContent') && online.includes('offlineMode = false') && online.includes('offlineMode: offlineMode === true'));
check('submission persists provider-neutral immutable artifact/hash before provider send', submission.includes('ArtifactSchema') && submission.includes('content: { type: String, required: true }') && submission.includes('sha256Hex') && submission.includes('providerData') && submissions.includes('createOrGetSubmission'));
check('submission is idempotent by snapshot/provider/environment', submission.includes('{ snapshotId: 1, provider: 1, environment: 1 }, { unique: true }') && submissions.includes('alreadySubmitted'));
check('ambiguous network send is never blindly replayed', submissions.includes('ksef_submission_ambiguous') && submissions.includes("['ksef_api_timeout', 'ksef_api_unavailable']") && submissions.includes('sessionReferenceNumber && submission.state === \'error\''));
check('opened online session is best-effort closed even when send fails', submissions.includes('bestEffortCloseSession') && submissions.includes('await bestEffortCloseSession(env, auth.accessToken, submission)'));
check('routine API never returns fiscal artifact content or KSeF credential plaintext', submissions.includes('const { content, ...artifactMeta }') && !routes.includes('decryptKsefToken') && !routes.includes('tokenEncrypted'));
check('raw upstream KSeF problem body is not exposed through AppError args', !http.includes('provider: parsed') && http.includes('providerMessage'));
check('KSeF provider is live but remains outside Invoice Core finalization', adapter.includes('IMPLEMENTATION.LIVE') && !invoiceService.includes('services/invoices/ksef') && !invoiceService.includes('fiscalProviders/ksef'));
check('Stage 3 online transport still defaults offlineMode=false and later inbound stays outside outbound submission path', online.includes('offlineMode = false') && !submissions.includes('inboundSync') && !submissions.includes('InboundFiscalDocument'));
check('admin-only HTTP surface exposes connection/validate/submit/status operations', routes.includes('router.use(adminOnly)') && routes.includes("'/ksef/connections'") && routes.includes("'/:id/fiscal/ksef/validate'") && routes.includes("'/:id/fiscal/ksef/submit'") && routes.includes("'/:id/fiscal/ksef/status'"));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 3 static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 3 static contract passed: ${checks.length}/${checks.length}`);
