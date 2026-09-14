'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const pkg = JSON.parse(read('package.json'));
const xadesModel = read('models/KsefXadesCredential.js');
const authSessionModel = read('models/KsefXadesAuthSession.js');
const enrollmentModel = read('models/KsefCertificateEnrollment.js');
const xadesCrypto = read('services/invoices/ksef/xadesCrypto.js');
const xadesStore = read('services/invoices/ksef/xadesCredentials.js');
const xadesAuth = read('services/invoices/ksef/xadesAuth.js');
const csr = read('services/invoices/ksef/csr.js');
const enrollments = read('services/invoices/ksef/certificateEnrollments.js');
const http = read('services/invoices/ksef/http.js');
const offlineStore = read('services/invoices/ksef/offlineCertificates.js');
const routes = read('routes/invoices.js');
const errors = read('utils/errors.js');
const pure = read('tests/invoiceKsefStage5B.pure.js');
const doc = read('docs/invoices/INVOICE-KSEF-STAGE5B.md');

check('Stage 5B XAdES, CSR, credential/session and enrollment files exist',
  exists('models/KsefXadesCredential.js') &&
  exists('models/KsefXadesAuthSession.js') &&
  exists('models/KsefCertificateEnrollment.js') &&
  exists('services/invoices/ksef/xadesCrypto.js') &&
  exists('services/invoices/ksef/xadesCredentials.js') &&
  exists('services/invoices/ksef/xadesAuth.js') &&
  exists('services/invoices/ksef/csr.js') &&
  exists('services/invoices/ksef/certificateEnrollments.js'));

check('AuthTokenRequest uses current KSeF 2.1 namespace and explicit NIP context',
  xadesCrypto.includes("const AUTH_NS = 'http://ksef.mf.gov.pl/auth/token/2.1'") &&
  xadesCrypto.includes('<ContextIdentifier><Nip>') &&
  xadesCrypto.includes('<SubjectIdentifierType>'));

check('XAdES uses XAdES-BES SignedProperties and enveloped/exclusive document transforms',
  xadesCrypto.includes("const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#'") &&
  xadesCrypto.includes("const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties'") &&
  xadesCrypto.includes("const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'") &&
  xadesCrypto.includes("const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'") &&
  xadesCrypto.includes('Target="#Signature"'));

check('inclusive SignedInfo canonicalization carries inherited AuthTokenRequest namespace context',
  xadesCrypto.includes('`<ds:SignedInfo xmlns="${AUTH_NS}" xmlns:ds="${DS_NS}">') &&
  xadesCrypto.includes("const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'"));

check('XAdES signs document and SignedProperties SHA-256 digests and embeds signing certificate identity',
  xadesCrypto.includes('documentDigest = sha256Base64') &&
  xadesCrypto.includes('signedPropertiesDigest = sha256Base64') &&
  xadesCrypto.includes('<xades:SigningCertificate>') &&
  xadesCrypto.includes('<ds:X509Certificate>'));

check('XAdES RSA uses SHA-256 and EC XMLDSIG uses IEEE-P1363 R||S',
  xadesCrypto.includes("RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'") &&
  xadesCrypto.includes("ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256'") &&
  xadesCrypto.includes("dsaEncoding: 'ieee-p1363'"));

check('XAdES certificate/private key are matched and weak/unsupported keys fail closed',
  xadesCrypto.includes('assertCertificateMatchesPrivateKey') &&
  xadesCrypto.includes('modulusLength < 2048') &&
  xadesCrypto.includes("['prime256v1', 'P-256', 'secp256r1', 'secp384r1', 'P-384', 'secp521r1', 'P-521']") &&
  errors.includes('ksef_xades_private_key_algorithm_invalid'));

check('generated XAdES is locally self-verified before any provider request',
  xadesCrypto.includes('verifyGeneratedXades(result, inspected.certificate)') &&
  xadesCrypto.includes("throw appError('ksef_xades_self_verification_failed')") &&
  xadesAuth.includes('signAuthTokenRequest({'));

check('XAdES credential private key and certificate bytes are hidden from routine reads',
  xadesModel.includes('certificateBase64: { type: String, required: true, select: false }') &&
  xadesModel.includes('privateKeyEncrypted: { type: EncryptedSecretSchema, required: true, select: false }') &&
  xadesModel.includes('privateKeyFingerprint: { type: String, required: true, select: false }') &&
  !xadesModel.includes('privateKey: { type: String'));

check('XAdES credential is identity-level and is not structurally bound to a LegalEntity',
  !xadesModel.includes('legalEntityId:') &&
  xadesModel.includes("source: { type: String, required: true, enum: ['manual_import', 'ksef_enrollment']"));

check('XAdES private key uses the existing AES-256-GCM secret boundary with scoped AAD',
  xadesStore.includes("encryptSecret(canonicalPrivateKey, secretScope(credentialId), 'xades-private-key')") &&
  xadesStore.includes("decryptSecret(credential.privateKeyEncrypted, secretScope(credential.credentialId), 'xades-private-key')"));

check('KSeF Authentication certificate Key Usage is verified instead of trusting request metadata',
  xadesStore.includes('extractKeyUsageBitsFromDer') &&
  xadesStore.includes('usage.digitalSignature') &&
  xadesStore.includes('usage.contentCommitment') &&
  xadesStore.includes('assertAuthenticationCertificateUsage'));

check('access/refresh tokens are encrypted in a context-specific XAdES auth session',
  authSessionModel.includes('legalEntityId: { type: mongoose.Schema.Types.ObjectId') &&
  authSessionModel.includes('accessTokenEncrypted: { type: EncryptedSecretSchema') &&
  authSessionModel.includes('refreshTokenEncrypted: { type: EncryptedSecretSchema') &&
  xadesAuth.includes('authSessionId(credentialId, legalEntityId, environment)') &&
  xadesAuth.includes("encryptSecret(accessToken, session.sessionId, 'xades-access-token')") &&
  xadesAuth.includes("encryptSecret(refreshToken, session.sessionId, 'xades-refresh-token')"));

check('XAdES authentication sends raw XML to the dedicated endpoint, never JSON-stringifies it',
  xadesAuth.includes('`/auth/xades-signature?verifyCertificateChain=${') &&
  xadesAuth.includes('rawBody: signed.signedXml') &&
  xadesAuth.includes("contentType: 'application/xml; charset=utf-8'") &&
  http.includes('rawBody !== undefined ? rawBody') &&
  http.includes("throw appError('ksef_http_body_conflict')"));

check('XAdES authentication follows challenge -> status -> redeem and supports refresh',
  xadesAuth.includes("'/auth/challenge'") &&
  xadesAuth.includes('`/auth/${encodeURIComponent(referenceNumber)}`') &&
  xadesAuth.includes("'/auth/token/redeem'") &&
  xadesAuth.includes("'/auth/token/refresh'"));

check('DEMO/PROD certificate-chain verification cannot be disabled by API input',
  xadesStore.includes("const chainVerification = env === 'test' ? verifyCertificateChain !== false : true") &&
  xadesAuth.includes("const verifyChain = credential.environment === 'test' ? credential.verifyCertificateChain !== false : true"));

check('certificate enrollment uses XAdES access token only and never system-token getAccessToken',
  enrollments.includes('getXadesAccessToken') &&
  !enrollments.includes('getAccessToken(') &&
  enrollments.includes("'/certificates/enrollments/data'") &&
  enrollments.includes("'/certificates/enrollments'"));

check('PKCS#10 DN uses official KSeF OIDs and preserves repeated givenName values',
  csr.includes("['commonName', '2.5.4.3']") &&
  csr.includes("['surname', '2.5.4.4']") &&
  csr.includes("['serialNumber', '2.5.4.5']") &&
  csr.includes("['countryName', '2.5.4.6']") &&
  csr.includes("['organizationName', '2.5.4.10']") &&
  csr.includes("['givenName', '2.5.4.42']") &&
  csr.includes("['uniqueIdentifier', '2.5.4.45']") &&
  csr.includes("['organizationIdentifier', '2.5.4.97']") &&
  csr.includes('const values = Array.isArray(raw)'));

check('CSR keys are exactly EC P-256 or RSA 2048 and EC CSR signature remains RFC3279 DER',
  csr.includes("generateKeyPairSync('ec', { namedCurve: 'prime256v1' })") &&
  csr.includes("generateKeyPairSync('rsa', { modulusLength: 2048") &&
  csr.includes("dsaEncoding: 'der'") &&
  csr.includes("oid('1.2.840.10045.4.3.2')") &&
  csr.includes("oid('1.2.840.113549.1.1.11')"));

check('CSR is DER Base64 and self-verifies before persistence/provider POST',
  csr.includes("csrDer.toString('base64')") &&
  csr.includes('verifyCertificationRequestInfo') &&
  csr.includes("throw appError('ksef_certificate_csr_self_verification_failed')") &&
  enrollments.includes('generateCertificateSigningRequest(enrollmentData'));

check('certificate enrollment persists encrypted private key before provider POST',
  enrollments.indexOf('await enrollment.save();') < enrollments.indexOf("'/certificates/enrollments'") &&
  enrollments.includes("encryptSecret(csr.privateKeyPem, secretScope(enrollmentId), 'certificate-private-key')") &&
  enrollmentModel.includes('privateKeyEncrypted: { type: EncryptedSecretSchema, default: null, select: false }'));

check('ambiguous enrollment POST is fail-closed and never blindly replayed',
  enrollments.includes('function isAmbiguousPostError') &&
  enrollments.includes("error?.code === 'ksef_api_error'") &&
  enrollments.includes('>= 500') &&
  enrollments.includes("enrollment.state = 'ambiguous_submit'") &&
  enrollments.includes("throw appError('ksef_certificate_enrollment_ambiguous'"));

check('certificate enrollment polling handles provider retention expiry 410 as manual review',
  enrollments.includes('Number(error?.args?.httpStatus || error?.ksef?.httpStatus || 0) === 410') &&
  enrollments.includes("enrollment.state = 'manual_review'") &&
  enrollments.includes("ksef_certificate_enrollment_status_expired") &&
  errors.includes('ksef_certificate_enrollment_status_expired'));

check('issued certificate retrieval is pinned to exact 16-hex serial and requested type',
  enrollments.includes("const SERIAL_RE = /^[0-9A-F]{16}$/") &&
  enrollments.includes("'/certificates/retrieve'") &&
  enrollments.includes('matching.length !== 1') &&
  enrollments.includes('issuedType !== enrollment.certificateType'));

check('issued Authentication/Offline certificates reuse strict encrypted stores and enrollment key is cleared',
  enrollments.includes('storeIssuedOfflineCertificate({') &&
  enrollments.includes('storeIssuedAuthenticationCredential({') &&
  enrollments.includes('enrollment.privateKeyEncrypted = undefined') &&
  offlineStore.includes("source: 'ksef_enrollment'") &&
  xadesStore.includes("source: 'ksef_enrollment'"));

check('certificate revocation uses XAdES auth and invalidates matching local credentials/tokens',
  enrollments.includes("`/certificates/${encodeURIComponent(serial)}/revoke`") &&
  enrollments.includes('getXadesAccessToken(xadesCredentialId, legalEntityId)') &&
  xadesStore.includes('KsefXadesAuthSession.deleteMany({ credentialId: { $in: credentialIds } })') &&
  offlineStore.includes('markOfflineCertificateRevoked'));

check('Stage 5B HTTP surface is admin-only and exposes credential/enrollment lifecycle routes',
  routes.includes('router.use(adminOnly)') &&
  routes.includes("'/ksef/xades-credentials'") &&
  routes.includes("'/ksef/xades-credentials/:credentialId/check'") &&
  routes.includes("'/ksef/certificate-limits'") &&
  routes.includes("'/ksef/certificate-enrollments'") &&
  routes.includes("'/ksef/certificate-enrollments/:enrollmentId/reconcile'") &&
  routes.includes("'/ksef/certificates/:certificateSerialNumber/revoke'"));

check('routine API serializers do not expose XAdES certificate/private keys, CSR or enrollment private key',
  xadesStore.includes('function publicXadesCredential') &&
  !xadesStore.slice(xadesStore.indexOf('function publicXadesCredential'), xadesStore.indexOf('function assertAuthenticationCertificateUsage')).includes('certificateBase64:') &&
  !xadesStore.slice(xadesStore.indexOf('function publicXadesCredential'), xadesStore.indexOf('function assertAuthenticationCertificateUsage')).includes('privateKeyEncrypted:') &&
  enrollments.includes('function publicEnrollment') &&
  !enrollments.slice(enrollments.indexOf('function publicEnrollment'), enrollments.indexOf('function normalizeCertificateName')).includes('csrBase64:') &&
  !enrollments.slice(enrollments.indexOf('function publicEnrollment'), enrollments.indexOf('function normalizeCertificateName')).includes('privateKeyEncrypted:'));

check('pure Stage 5B gate exercises RSA+EC XAdES, P1363, tamper rejection and both CSR algorithms',
  pure.includes("xadesFor('rsa')") && pure.includes("xadesFor('ec')") &&
  pure.includes("P-256 XMLDSIG ECDSA must be IEEE-P1363 R||S") &&
  pure.includes('tampered AuthTokenRequest must fail local verification') &&
  pure.includes("for (const keyAlgorithm of ['ec', 'rsa'])") &&
  !pure.includes('mongoose'));

check('Stage 5B tests generate ephemeral X.509 material and ship no static private-key fixture',
  exists('tests/helpers/ksefStage5BX509.js') &&
  pure.includes('generateEphemeralCertificate') &&
  !exists('tests/fixtures/ksef-stage5b/xades-rsa-key.pem') &&
  !exists('tests/fixtures/ksef-stage5b/xades-ec-key.pem') &&
  doc.includes('TEST-ONLY'));

check('package exposes Stage 5B pure and static gates without adding a new runtime dependency',
  pkg.scripts?.['test:invoice:stage5b'] === 'node tests/invoiceKsefStage5B.pure.js' &&
  pkg.scripts?.['test:invoice:stage5b:static'] === 'node scripts/checkInvoiceKsefStage5B.js' &&
  !pkg.dependencies?.['xml-crypto'] && !pkg.dependencies?.['node-forge']);

check('Stage 5B error dictionary remains explicit/fail-closed',
  errors.includes('ksef_xades_self_verification_failed') &&
  errors.includes('ksef_certificate_csr_self_verification_failed') &&
  errors.includes('ksef_certificate_enrollment_ambiguous') &&
  errors.includes('ksef_certificate_enrollment_status_expired') &&
  errors.includes('ksef_certificate_retrieve_response_invalid'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice KSeF Stage 5B static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice KSeF Stage 5B static contract passed: ${checks.length}/${checks.length}`);
