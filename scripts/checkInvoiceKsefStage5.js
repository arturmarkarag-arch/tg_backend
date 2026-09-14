'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const pkg = JSON.parse(read('package.json'));
const certModel = read('models/KsefOfflineCertificate.js');
const certCrypto = read('services/invoices/ksef/offlineCertificateCrypto.js');
const certStore = read('services/invoices/ksef/offlineCertificates.js');
const qr = read('services/invoices/ksef/offlineQr.js');
const config = read('services/invoices/ksef/config.js');
const submissionModel = read('models/FiscalSubmission.js');
const submissions = read('services/invoices/ksef/submissions.js');
const online = read('services/invoices/ksef/online.js');
const contract = read('services/invoices/fiscalProviders/contract.js');
const adapter = read('services/invoices/fiscalProviders/ksef.js');
const routes = read('routes/invoices.js');
const errors = read('utils/errors.js');
const pure = read('tests/invoiceKsefStage5.pure.js');
const stage1Runtime = read('tests/invoiceCoreStage1.test.js');
const doc = read('docs/invoices/INVOICE-KSEF-STAGE5A.md');
const certEnrollments = exists('services/invoices/ksef/certificateEnrollments.js') ? read('services/invoices/ksef/certificateEnrollments.js') : '';

check('Stage 5A offline certificate, QR and executable test files exist',
  exists('models/KsefOfflineCertificate.js') &&
  exists('services/invoices/ksef/offlineCertificateCrypto.js') &&
  exists('services/invoices/ksef/offlineCertificates.js') &&
  exists('services/invoices/ksef/offlineQr.js') &&
  exists('tests/invoiceKsefStage5.pure.js'));
check('Offline certificate private material is hidden and encrypted at rest',
  certModel.includes('certificateBase64: { type: String, required: true, select: false }') &&
  certModel.includes('privateKeyEncrypted: { type: EncryptedSecretSchema, required: true, select: false }') &&
  certModel.includes('privateKeyFingerprint: { type: String, required: true, select: false }') &&
  !certModel.includes('privateKey: { type: String'));
check('manual import is explicitly restricted to KSeF Offline certificate type',
  certModel.includes("enum: ['Offline']") && certModel.includes("'manual_import', 'ksef_enrollment'") &&
  certStore.includes("String(certificateType || '').trim() !== 'Offline'") &&
  certStore.includes("certificateType: 'Offline'") && certStore.includes("source: 'manual_import'"));
check('certificate DER and private key are cryptographically matched before storage',
  certCrypto.includes('assertCertificateMatchesPrivateKey') &&
  certCrypto.includes("crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })") &&
  certCrypto.includes("certificate.publicKey.export({ format: 'der', type: 'spki' })"));
check('X.509 Key Usage rejects Authentication certs disguised as Offline certs',
  certCrypto.includes('extractKeyUsageBitsFromDer') &&
  certCrypto.includes('contentCommitment') &&
  certCrypto.includes('digitalSignature') &&
  certCrypto.includes('assertOfflineCertificateUsage(certificate)') &&
  errors.includes('ksef_offline_certificate_usage_invalid'));
check('Offline signing keys are limited to RSA >=2048 or EC P-256',
  certCrypto.includes('modulusLength < 2048') &&
  certCrypto.includes("['prime256v1', 'P-256', 'secp256r1']") &&
  errors.includes('ksef_offline_private_key_algorithm_invalid'));
check('private key uses the existing AES-256-GCM KSeF secret boundary with scoped AAD',
  certStore.includes("encryptSecret(canonicalPrivateKey, secretScope(certificateId), 'offline-private-key')") &&
  certStore.includes("decryptSecret(certificate.privateKeyEncrypted, secretScope(certificate.certificateId), 'offline-private-key')") &&
  certStore.includes('fingerprint(canonicalPrivateKey)'));
check('routine certificate serialization never exposes DER or private secret material',
  certStore.includes('function publicOfflineCertificate') &&
  !certStore.slice(certStore.indexOf('function publicOfflineCertificate'), certStore.indexOf('async function assertLegalEntityForOffline')).includes('certificateBase64:') &&
  !certStore.slice(certStore.indexOf('function publicOfflineCertificate'), certStore.indexOf('async function assertLegalEntityForOffline')).includes('privateKeyEncrypted:'));
check('TEST DEMO PROD QR base URLs are explicit',
  config.includes('https://qr-test.ksef.mf.gov.pl') &&
  config.includes('https://qr-demo.ksef.mf.gov.pl') &&
  config.includes('https://qr.ksef.mf.gov.pl'));
check('QR I uses seller NIP, P_1 DD-MM-YYYY and immutable SHA-256 Base64URL',
  qr.includes('/invoice/${nip}/${issueDateForQr(issueDate)}/${invoiceHashBase64Url(invoiceHashBase64)}') &&
  qr.includes("toString('base64url')") &&
  qr.includes('bytes.length !== 32'));
check('QR II supports official ContextIdentifier path and signs path without https prefix',
  qr.includes("['Nip', 'InternalId', 'NipVatUe', 'PeppolId']") &&
  qr.includes('/certificate/${contextType}/') &&
  qr.includes("unsignedUrl.replace(/^https:\\/\\//, '')"));
check('QR II RSA is RSASSA-PSS SHA-256 salt32 and EC is P-256 IEEE-P1363',
  qr.includes('RSA_PKCS1_PSS_PADDING') && qr.includes('saltLength: 32') &&
  qr.includes("crypto.sign('sha256'") && qr.includes("dsaEncoding: 'ieee-p1363'"));
check('offline24 preparation reuses immutable finalized FA(3) artifact and real XSD validation',
  submissions.includes('async function prepareOffline24Invoice') &&
  submissions.includes('const artifact = await buildArtifact(invoiceId)') &&
  submissions.includes('await validateFa3Xml(xml)') &&
  submissions.includes('artifact.xmlHashBase64'));
const prepareStart = submissions.indexOf('async function prepareOffline24Invoice');
const prepareEnd = submissions.indexOf('async function submitInvoiceToKsef', prepareStart);
const prepareSlice = submissions.slice(prepareStart, prepareEnd);
check('offline24 preparation is local-only and performs no KSeF network authentication/send',
  !prepareSlice.includes('getAccessToken(') &&
  !prepareSlice.includes('openOnlineSessionWithKeyRecovery(') &&
  !prepareSlice.includes('sendInvoice(') &&
  !prepareSlice.includes('ksefRequest('));
check('offline24 persists QR I/II metadata but never persists private key',
  prepareSlice.includes("mode: 'offline24'") && prepareSlice.includes("qrI: { url: qrIUrl, label: 'OFFLINE' }") &&
  prepareSlice.includes("qrII: { url: qrIIUrl, label: 'CERTYFIKAT' }") &&
  prepareSlice.includes('certificateSerialNumber') &&
  !prepareSlice.includes('privateKeyEncrypted') && !prepareSlice.includes('privateKey: privateKey'));
check('FiscalSubmission keeps one immutable snapshot/provider/environment identity while recording online/offline24 mode',
  submissionModel.includes('mode: { type: String, required: true') &&
  submissionModel.includes("index({ snapshotId: 1, provider: 1, environment: 1 }, { unique: true })") &&
  submissions.includes("['online', 'offline24'].includes(requestedMode)"));
check('offline24 upload reuses online encrypted transport with explicit offlineMode=true while online defaults false',
  online.includes('offlineMode = false') && online.includes('offlineMode: offlineMode === true') &&
  submissions.includes("const offlineMode = submission.mode === 'offline24'") &&
  submissions.includes('sendInvoice(env, auth.accessToken, session, submission.artifact.content, { offlineMode })'));
check('provider-neutral fiscal contract exposes offline preparation only when capability is live',
  contract.includes('capabilities[CAPABILITIES.OFFLINE]') && contract.includes('definition.prepareOffline') &&
  adapter.includes('[CAPABILITIES.OFFLINE]: true') && adapter.includes('prepareOffline:'));
check('Stage 5A admin-only surface manages imported cert metadata and offline24 preparation',
  routes.includes('router.use(adminOnly)') &&
  routes.includes("'/ksef/offline-certificates'") &&
  routes.includes("'/ksef/offline-certificates/:certificateId'") &&
  routes.includes("'/:id/fiscal/ksef/offline24/prepare'"));
check('certificate enrollment stays outside Offline store and never falls back to KSeF system-token auth',
  !certStore.includes('enrollments/data') &&
  (!certEnrollments || (certEnrollments.includes('getXadesAccessToken') && !certEnrollments.includes('getAccessToken('))) &&
  doc.includes('Stage 5B') && doc.includes('XAdES'));
check('pure Stage 5A gate verifies QR I, RSA-PSS, EC P1363 and X.509 Key Usage without DB dependencies',
  pure.includes('buildInvoiceVerificationUrl') && pure.includes('RSA_PKCS1_PSS_PADDING') &&
  pure.includes("dsaEncoding: 'ieee-p1363'") && pure.includes('assertOfflineCertificateUsage') &&
  !pure.includes('mongoose') && !pure.includes("require('../services/invoices/ksef/online')"));
check('Stage 1 regression fixture now reflects Stage 2 finalization numbering contract',
  stage1Runtime.includes("invoiceNumber: 'TEST/FV/1/2026'") && stage1Runtime.includes('validateFinalizableInvoice(draft)'));
check('package exposes Stage 5A pure and static gates',
  pkg.scripts?.['test:invoice:stage5'] === 'node tests/invoiceKsefStage5.pure.js' &&
  pkg.scripts?.['test:invoice:stage5:static'] === 'node scripts/checkInvoiceKsefStage5.js');
check('Stage 5A error dictionary is explicit and fail-closed',
  errors.includes('ksef_offline_certificate_key_mismatch') &&
  errors.includes('ksef_offline_certificate_not_valid_now') &&
  errors.includes('ksef_offline_context_identifier_invalid') &&
  errors.includes('ksef_submission_mode_conflict'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 5A static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 5A static contract passed: ${checks.length}/${checks.length}`);
