# Invoice / KSeF Stage 7 — inbound business linking

Stage 7 connects immutable received fiscal documents to ERP business objects without turning KSeF sync into a warehouse mutation source.

## Boundaries

- `InboundFiscalDocument` remains the provider-neutral received fiscal artifact.
- `BusinessCounterparty` is the ERP supplier/customer master; KSeF-specific ids do not live in it.
- `InboundFiscalBusinessLink` is the only durable link ledger.
- Candidate generation never changes `Receipt`, `ReceiptItem`, `Product`, `ShopProduct`, stock, routing or order state.
- Matcher results are always `suggested`; only an authenticated admin can `confirm` or `reject`.
- One inbound document may confirm at most one supplier counterparty, enforced in MongoDB.
- One supplier invoice may legitimately cover multiple physical Receipts, so confirmed receipt links are not artificially unique.

## Matching evidence

Supplier candidate scoring prefers exact normalized tax identity. Name/country are supporting evidence only. A conflicting tax id is a hard negative.

Receipt matching is deliberately weaker because the existing receipt domain has no supplier NIP, supplier invoice number or purchase total. Candidates use only bounded evidence available today:

- receive/completion date proximity;
- invoice FA(3) line count versus ReceiptItem count;
- total line quantity versus `ReceiptItem.totalQty` where both sides exist;
- conservative token overlap between invoice line names and receipt item names.

Even a score of 100 never confirms a link automatically.

## HTTP (admin only)

- `GET /api/invoices/business-counterparties`
- `POST /api/invoices/business-counterparties`
- `PATCH /api/invoices/business-counterparties/:id`
- `GET /api/invoices/ksef/inbound-documents/:documentId/business-links`
- `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/refresh`
- `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/confirm`
- `POST /api/invoices/ksef/inbound-documents/:documentId/business-links/:linkId/reject`

## Out of scope

- automatic inventory mutation;
- automatic Receipt confirmation;
- purchase accounting/payment posting;
- frontend;
- supplier invoices creating warehouse receipts by themselves.
