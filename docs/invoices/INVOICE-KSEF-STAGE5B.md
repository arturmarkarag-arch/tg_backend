# Invoice / KSeF Stage 5B — XAdES authentication and certificate enrollment

Date: 2026-09-14
Scope: backend only

## Goal

Stage 5B adds a real KSeF XAdES authentication boundary and the KSeF certificate enrollment lifecycle on top of Stage 5A. It does not add frontend UI and does not weaken the existing system-token provider path.

The implementation follows the current KSeF 2.0 authentication/certificate contracts:

- `AuthTokenRequest` namespace 2.1;
- raw XML `POST /auth/xades-signature`;
- XAdES SignedProperties and certificate identity;
- challenge -> async auth status -> redeem JWT, with refresh-token reuse;
- certificate operations only through an access token obtained from XAdES auth;
- `/certificates/enrollments/data` -> PKCS#10 CSR -> enrollment -> async status -> retrieve;
- certificate revocation and local invalidation.

## Security boundary

### Identity credential vs business context

`KsefXadesCredential` is identity-level. It is intentionally **not** owned by a `LegalEntity` because a KSeF certificate is an identity carrier, not a KSeF context assignment.

A `LegalEntity` is supplied only when authenticating. Access/refresh JWTs are stored in `KsefXadesAuthSession`, keyed by:

```text
credentialId + legalEntityId + environment
```

This prevents a JWT obtained in one NIP context from being accidentally reused in another context.

### Secrets

The following values are `select:false` and are never exposed by routine REST serializers:

- XAdES certificate DER/Base64;
- XAdES private key;
- access token;
- refresh token;
- enrollment CSR bytes;
- generated enrollment private key.

Private keys and JWTs reuse the existing KSeF AES-256-GCM secret store with scoped AAD.

## XAdES implementation

The signer is deliberately provider-specific and narrow. It signs only the KSeF `AuthTokenRequest 2.1` contract instead of exposing a generic XML-signature facility.

Generated signature contains:

- XMLDSIG `Signature` with Id `Signature`;
- SHA-256 digest of the unsigned AuthTokenRequest;
- enveloped-signature + exclusive-C14N transforms for the root reference;
- XAdES `SignedProperties` with Id `SignedProperties`;
- SigningTime;
- SHA-256 digest of the signing certificate;
- issuer + decimal serial;
- X509 certificate in `KeyInfo`;
- local cryptographic self-verification before the XML may leave the backend.

`SignedInfo` uses inclusive C14N 1.0. The inherited default `AuthTokenRequest` namespace is included explicitly in the canonical form. This is required because a locally valid signature over a namespace-incomplete serialization can still be rejected by a standards-compliant verifier.

### RSA

- RSA key >= 2048 bit;
- SHA-256;
- RSA PKCS#1 v1.5 XMLDSIG signature.

### EC

- supported EC curves >= 256 bit for imported XAdES credentials;
- XMLDSIG ECDSA `SignatureValue` is IEEE P1363 `R || S`;
- for P-256 this is exactly 64 bytes before Base64 encoding.

This is intentionally different from CSR ECDSA encoding.

## PKCS#10 CSR

Certificate enrollment CSR is generated locally with no third-party ASN.1/XML dependency.

Supported CSR key profiles are intentionally narrower than the general XAdES importer:

- EC: NIST P-256 / secp256r1;
- RSA: exactly 2048 bit.

The CSR is DER-encoded and Base64-encoded for KSeF.

DN values are copied from `/certificates/enrollments/data`; Stage 5B does not allow the client to supply or override those identity fields. Supported official OIDs are:

```text
2.5.4.3   commonName
2.5.4.4   surname
2.5.4.5   serialNumber
2.5.4.6   countryName
2.5.4.10  organizationName
2.5.4.42  givenName
2.5.4.45  uniqueIdentifier
2.5.4.97  organizationIdentifier
```

`givenName` remains multi-valued and is emitted once per returned value.

CSR ECDSA signatures use ASN.1 DER/RFC3279 encoding, not IEEE-P1363. RSA CSR uses SHA-256 with PKCS#1 v1.5.

Both generated CSR profiles are self-verified in Node before they can be persisted/sent. During development they were additionally verified independently with `openssl req -verify`.

## Authentication lifecycle

For a credential + LegalEntity context:

```text
POST /auth/challenge
  -> build AuthTokenRequest 2.1
  -> sign XAdES
  -> POST /auth/xades-signature
  -> GET /auth/{referenceNumber} until terminal
  -> POST /auth/token/redeem
  -> encrypt context-specific access + refresh tokens
```

Existing valid access JWT is reused. If possible, the refresh JWT is used first. A failed/expired auth path falls back to a fresh XAdES authentication.

`verifyCertificateChain=false` is allowed only in the `test` environment. DEMO/PROD always force certificate-chain verification.

## Certificate enrollment lifecycle

Creation:

```text
XAdES access token
  -> GET /certificates/limits
  -> GET /certificates/enrollments/data
  -> generate key + PKCS#10 CSR
  -> persist encrypted private key + CSR metadata FIRST
  -> POST /certificates/enrollments
```

Persisting the private key before the provider POST is mandatory: KSeF returns the certificate later, not the generated private key.

### Ambiguous POST

A timeout, connection loss, or HTTP 5xx after the POST is treated as ambiguous. The enrollment is persisted as `ambiguous_submit`; automatic replay is forbidden because another POST could create an additional certificate request.

### Status and retrieval

For a known provider reference:

```text
GET /certificates/enrollments/{referenceNumber}
  -> status 200
  -> exact 16-hex certificate serial
  -> POST /certificates/retrieve
  -> verify one exact serial + expected certificate type
  -> verify certificate/private-key pair in the destination store
  -> store Authentication or Offline credential encrypted at rest
  -> clear enrollment privateKeyEncrypted
```

KSeF retains the technical enrollment status for 30 days. HTTP 410 therefore becomes `manual_review`, not an automatic retry/re-enrollment.

## Revocation

Revocation requires an XAdES-authenticated access token:

```text
POST /certificates/{serial}/revoke
```

After upstream success the backend:

- marks matching Authentication credentials revoked/disabled;
- deletes all cached XAdES access/refresh sessions for those credentials;
- marks matching Offline certificates revoked/disabled/non-default.

No local revocation state is applied before upstream success.

## HTTP surface

All Stage 5B routes stay behind the invoice router `adminOnly` boundary:

```text
GET   /api/invoices/ksef/xades-credentials
POST  /api/invoices/ksef/xades-credentials
PATCH /api/invoices/ksef/xades-credentials/:credentialId
POST  /api/invoices/ksef/xades-credentials/:credentialId/check

GET   /api/invoices/ksef/certificate-limits
GET   /api/invoices/ksef/certificate-enrollments
POST  /api/invoices/ksef/certificate-enrollments
GET   /api/invoices/ksef/certificate-enrollments/:enrollmentId
POST  /api/invoices/ksef/certificate-enrollments/:enrollmentId/reconcile
POST  /api/invoices/ksef/certificates/:certificateSerialNumber/revoke
```

## Tests

```text
npm run test:invoice:stage5b:static
npm run test:invoice:stage5b
npm run test:security:endpoint-matrix
```

The pure test uses **TEST-ONLY** ephemeral RSA and EC keypairs and self-signed X.509 certificates generated in memory at test runtime. No static private-key fixture is shipped in the repository; these certificates carry no real KSeF access.

The Stage 5B pure gate verifies:

- RSA XAdES;
- EC XAdES and 64-byte P-256 IEEE-P1363 signature;
- root/SignedProperties transforms;
- AuthTokenRequest 2.1 namespace;
- tamper rejection;
- repeated `givenName` preservation;
- EC P-256 CSR;
- RSA 2048 CSR.

## Explicitly not claimed by this stage

A local cryptographic test cannot prove that a real qualified/personal seal certificate is accepted by KSeF TEST/DEMO/PROD. Final interoperability requires a live KSeF TEST authentication using an appropriate real/test identity and permissions.

No frontend certificate management UI is part of Stage 5B.
