# Invoice KSeF — Stage 4: durable reconciliation and UPO

Stage 4 hardens the already-live KSeF Online submission path. It does not add offline mode or inbound invoice synchronization.

## Boundary

```text
finalized InvoiceSnapshot
        |
        v
Stage 3: validate -> online session -> send
        |
        v
FiscalSubmission
        |
        +--> durable GET-only reconciliation
        |      +--> recover lost invoice reference by immutable invoiceHash
        |      +--> poll invoice status
        |      +--> terminal/manual-review policy
        |
        +--> verified per-invoice UPO
               +--> raw response bytes
               +--> x-ms-meta-hash SHA-256 verification
               +--> Base64 byte-exact storage
```

## Ambiguous send recovery

A timeout or transport failure after the KSeF invoice POST is treated as ambiguous. Stage 4 never automatically repeats that POST.

Recovery is GET-only:

1. list invoices in the original KSeF session;
2. match the immutable `FiscalSubmission.artifact.hashBase64`;
3. exactly one match restores `invoiceReferenceNumber`;
4. more than one match fails closed to `manual_review`;
5. no match while the session is still processing schedules another reconciliation;
6. no match after a terminal session fails closed to `manual_review`.

This preserves the Stage 3 no-duplicate contract.

## Durable scheduler

`services/invoices/ksef/reconciliationScheduler.js` processes a small bounded batch under the existing distributed scheduler leader lock and an additional per-submission lease.

Defaults:

- tick: 30 seconds;
- lease: 90 seconds;
- batch: maximum 5;
- max retry backoff: 5 minutes;
- ambiguous session hash-not-yet-visible retry: 120 seconds;
- KSeF `Retry-After` is honored when present.

These conservative defaults keep recurring recovery/status GET traffic below the documented KSeF session/status rate envelopes. The scheduler can be disabled with `KSEF_RECONCILIATION_ENABLED=false`.

## UPO integrity

The UPO response is read as raw bytes, not decoded/re-encoded text. The SHA-256 is calculated over those exact bytes and compared with KSeF `x-ms-meta-hash`.

Storage is fail-closed:

- missing provider hash -> no UPO is persisted;
- hash mismatch -> no UPO is persisted;
- verified bytes are stored as Base64 in `FiscalSubmission.receipt.contentBase64`;
- routine submission JSON strips both invoice XML and UPO content;
- the explicit UPO download endpoint decodes and returns the original bytes.

## API additions

All invoice routes remain behind the existing admin-only middleware.

- `POST /api/invoices/:id/fiscal/ksef/reconcile`
- `GET /api/invoices/:id/fiscal/ksef/upo`

The UPO route returns XML as an attachment and includes `X-KSeF-UPO-SHA256`.

## Non-goals

Stage 4 still does not implement:

- KSeF offline modes;
- inbound invoice synchronization;
- QR/offline certificate flows;
- frontend KSeF UI.

## Local gates

```powershell
npm run test:invoice:stage3:static
npm run test:invoice:stage4:static
npm run test:invoice:stage4
npm run test:security:endpoint-matrix
```

The full Stage 3 XSD/WASM gate still requires installed npm dependencies:

```powershell
npm ci
npm run test:invoice:stage3
```
