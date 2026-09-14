# Invoice / KSeF Stage 6 — inbound received invoices

## Scope

Stage 6 is backend-only and keeps received fiscal documents separate from the outbound `Invoice` aggregate.

- `Invoice` = outbound fiscal document issued by us.
- `InboundFiscalDocument` = provider-neutral fiscal document received from an external fiscal provider.
- `KsefInboundSyncState` = durable KSeF Subject2 / PermanentStorage cursor and auth binding.
- `KsefInboundExport` = durable high-volume export operation, encryption material and provider status.

KSeF-specific identity stays in the adapter layer. Generic storage uses `providerDocumentId`, `providerArtifactHashBase64`, `providerStoredAt` and `sourceRole=buyer`.

Current KSeF metadata uses `invoiceHash` as the canonical SHA-256 identity. `fileHash` is accepted only as a compatibility fallback.

## Stage 6A — metadata + individual XML hydration

The low/medium-volume lane uses:

1. `POST /invoices/query/metadata`.
2. `subjectType=Subject2`.
3. `dateType=PermanentStorage`.
4. `restrictToPermanentStorageHwmDate=true`.
5. durable metadata upsert and provider-document deduplication.
6. scheduler-owned `GET /invoices/ksef/{ksefNumber}` hydration.
7. exact-byte SHA-256 verification and local immutable storage.

The metadata query window is capped at 90 days, `pageSize=250`, and `pageOffset` is a page number (`0`, `1`, `2`, ...).

If the KSeF metadata response is not truncated, the cursor advances only after the last page for the frozen window succeeds.

If `isTruncated=true`, Stage 6A does not ingest a partial page and does not advance the cursor. Control is handed to Stage 6B through a durable export job and the sync enters `export_wait`.

## Stage 6B — high-volume incremental export

Stage 6B implements the asynchronous KSeF export flow:

1. create a durable `KsefInboundExport` before provider POST;
2. generate a random AES-256 key and 16-byte IV;
3. encrypt both at rest with the existing KSeF AES-256-GCM secret boundary;
4. obtain the `SymmetricKeyEncryption` public key and `publicKeyId`;
5. RSA-OAEP/SHA-256 encrypt the AES key;
6. `POST /invoices/exports` with Subject2/PermanentStorage/HWM filters, `compressionType=TarGz`, `onlyMetadata=false`;
7. persist the returned `referenceNumber`;
8. poll `GET /invoices/exports/{referenceNumber}`;
9. download every signed package-part URL without forwarding a KSeF bearer token;
10. verify encrypted `size + SHA-256`;
11. decrypt the part with AES-256-CBC;
12. verify decrypted `size + SHA-256`;
13. append the decrypted part to a mode-0600 temporary TarGz spool;
14. stream-parse TAR.GZ with traversal/checksum/size protections;
15. read exactly one `_metadata.json`;
16. bulk-upsert metadata in bounded chunks;
17. match XML entries to metadata primarily by raw-byte SHA-256 / `invoiceHash`;
18. reuse Stage 6A immutable artifact + XSD validation storage;
19. advance the durable cursor only after the whole package passes every integrity check.

The high-volume path never concatenates a complete up-to-1-GiB package in RAM. One encrypted/decrypted provider part and one TAR entry are bounded in memory at a time, while the package itself is spooled to a temporary file.

## Export idempotency and ambiguous POST policy

`exportKey` is deterministic for `syncId + Subject2 + PermanentStorage from/to`. AES key and IV are persisted encrypted before the first provider POST.

If POST succeeds at KSeF but the response is lost due to timeout/5xx, the job becomes `ambiguous_submit` and the sync becomes `manual_review`. Stage 6B never blindly repeats a POST whose provider outcome is unknown.

After a `referenceNumber` is known, retries are GET/download-only and therefore do not create a second export operation.

The KSeF public-key rotation error is the only provider rejection that triggers a safe one-time POST retry because the rejected request did not start an export.

## Export part and archive integrity

Every package part must satisfy both provider identities:

- encrypted byte length = `encryptedPartSize`;
- SHA-256(encrypted bytes) = `encryptedPartHash`;
- AES-256-CBC decrypt succeeds with the persisted key/IV;
- decrypted byte length = `partSize`;
- SHA-256(decrypted bytes) = `partHash`.

TAR processing validates header checksums, rejects absolute paths, `..` traversal and backslashes, limits individual entries and total extracted bytes, and requires exactly one `_metadata.json`.

Signed download URLs must be HTTPS, contain no URL credentials and cannot use obvious localhost/literal-IP targets. The signed URLs are downloaded without the KSeF access token.

## Metadata / XML identity

The `_metadata.json` `invoices` array is the same provider metadata contract used by Stage 6A.

For each XML:

1. SHA-256 is calculated over the exact XML bytes;
2. that hash must exist in `_metadata.json` as `invoiceHash`;
3. the corresponding provider-neutral local document must carry the same `providerArtifactHashBase64`;
4. duplicate/ambiguous/unmatched XML fails the whole export;
5. the cursor is not moved on any mismatch.

Bulk metadata ingestion does not select already-stored raw XML into memory.

## HWM continuation

For a successful package:

- `isTruncated=true` -> next `cursorFrom = lastPermanentStorageDate`;
- otherwise -> next `cursorFrom = permanentStorageHwmDate`.

A truncated continuation must strictly advance beyond the current `from` value. Adjacent windows are intentional; duplicate documents are removed by provider document identity/hash.

The sync remains in `export_wait` while an export owns the current window. Manual cursor reset is blocked in this state.

## Authentication

Both Stage 6 lanes use the existing inbound auth binding:

- KSeF system-token connection, or
- Stage 5B XAdES credential/session,

bound to the same LegalEntity/environment.

## Scheduler and rate safety

The distributed inbound scheduler has three independent lanes per tick:

1. at most one metadata sync claim;
2. at most one export claim;
3. at most one individual XML hydration claim.

The export job has its own durable lease and backoff. A known export reference can safely retry status/download work. Signed part-link expiration or download failures are retried by polling status again, allowing KSeF to issue fresh signed URLs.

## Admin-only HTTP surface

Stage 6A:

- `GET /api/invoices/ksef/inbound-syncs`
- `POST /api/invoices/ksef/inbound-syncs`
- `PATCH /api/invoices/ksef/inbound-syncs/:syncId`
- `POST /api/invoices/ksef/inbound-syncs/:syncId/run`
- `POST /api/invoices/ksef/inbound-syncs/:syncId/reset-cursor`
- `GET /api/invoices/ksef/inbound-documents`
- `GET /api/invoices/ksef/inbound-documents/:documentId`
- `POST /api/invoices/ksef/inbound-documents/:documentId/fetch`
- `GET /api/invoices/ksef/inbound-documents/:documentId/xml`

Stage 6B:

- `GET /api/invoices/ksef/inbound-exports`
- `GET /api/invoices/ksef/inbound-exports/:exportId`
- `POST /api/invoices/ksef/inbound-syncs/:syncId/export` — queue-only, no direct provider request from the HTTP handler.

## Still out of scope

- frontend KSeF UI;
- Subject1/Subject3/authorized-subject inbound syncs;
- supplier-master matching;
- warehouse receipt/purchase linking;
- accounting/payment posting;
- live KSeF TEST export E2E without a real authorized identity/context.

## Gates

```text
npm run test:invoice:stage6:static
npm run test:invoice:stage6
npm run test:invoice:stage6b:static
npm run test:invoice:stage6b
npm run test:security:endpoint-matrix
```

The Stage 3 real FA(3) XSD/WASM smoke remains the runtime dependency gate for XSD validation.
