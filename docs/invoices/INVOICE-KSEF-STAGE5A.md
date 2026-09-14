# Invoice / KSeF Stage 5A — offline24 foundation

Stage 5A adds a fail-closed backend foundation for issuing an already-finalized FA(3) invoice in `offline24` mode. It deliberately does **not** implement certificate enrollment or inbound invoice synchronization.

## Scope

- manual import of an already-issued KSeF certificate of type `Offline`;
- local X.509 certificate/private-key match verification;
- verification that X.509 Key Usage is `Content Commitment / Non-Repudiation`, not Authentication `Digital Signature`;
- RSA >= 2048 or EC P-256 private keys only;
- private key encrypted at rest through the existing KSeF AES-256-GCM secret store and never returned by routine API responses;
- local KOD I and KOD II verification URLs for TEST, DEMO and PROD;
- `offline24` preparation from the immutable finalized `InvoiceSnapshot` and the exact FA(3) XML SHA-256;
- later upload through the existing encrypted online-session transport with `offlineMode: true`;
- one provider submission identity per immutable snapshot/provider/environment, preventing silent online/offline mode switching after preparation.

## Admin endpoints

- `GET /api/invoices/ksef/offline-certificates`
- `POST /api/invoices/ksef/offline-certificates`
- `PATCH /api/invoices/ksef/offline-certificates/:certificateId`
- `POST /api/invoices/:id/fiscal/ksef/offline24/prepare`

All invoice routes remain behind the existing admin-only boundary.

## Import contract

The import request supplies:

- `legalEntityId`;
- `environment` (`test`, `demo`, `prod`);
- `certificateType: "Offline"`;
- `certificateBase64` — DER certificate encoded with Base64;
- `privateKey` — PEM or Base64 DER PKCS#8/PKCS#1/SEC1 private key;
- optional display name / enabled / default flags.

The backend does not trust the declared certificate type alone. It checks the certificate Key Usage and rejects an Authentication certificate presented as Offline. The public key from the certificate must also match the supplied private key.

## Offline preparation

`offline24/prepare` is intentionally network-independent. It:

1. loads the finalized immutable snapshot;
2. regenerates the conservative FA(3) XML;
3. runs the real XSD validator;
4. uses that exact XML SHA-256 for KOD I and KOD II;
5. signs the KOD II path locally with the imported Offline certificate private key;
6. stores only verification URL/serial/certificate metadata in the fiscal submission.

No KSeF auth token, session opening, invoice POST, or remote certificate call occurs during preparation.

## Upload

When the prepared submission is later sent through the normal KSeF submit command, the existing online-session encryption path is reused and sends `offlineMode: true`. A normal online submission still defaults to `offlineMode: false`.

Stage 5A records the policy `next_business_day_after_issue_date` but does not yet calculate or enforce a Polish business-calendar deadline. Automated outage classification, technical correction and other offline modes remain separate work.

## Explicit Stage 5B boundary

KSeF certificate enrollment is **not** implemented in Stage 5A. The `/certificates/enrollments/data` flow requires authentication based on a signature/XAdES identity; the existing Stage 3 system-token authentication is not sufficient for that enrollment path.

Stage 5B should therefore add XAdES/certificate authentication and only then implement CSR/enrollment/status/retrieve/revocation lifecycle. It must not emulate enrollment with the current token-auth provider.
