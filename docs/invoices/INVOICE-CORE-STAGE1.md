# Invoice Core — Stage 1

## Boundary

Invoice creation and fiscal delivery are two independent axes:

`SOURCE PROVIDER -> INVOICE CORE -> FISCAL PROVIDER`

A source provider knows how to build a canonical invoice draft from one business source. A fiscal provider knows how to validate/submit a finalized immutable snapshot to an external fiscal/e-invoice system.

KSeF is therefore **not** an invoice source and Warehouse Order is **not** allowed to call KSeF directly.

## Stage 1 components

- `Invoice` — mutable canonical draft, then finalized pointer.
- `InvoiceSnapshot` — one immutable canonical payload + SHA-256 per finalized invoice.
- `sourceProviders/` — provider-neutral source contract and registry.
  - `manual`
  - `warehouse_order`
- `fiscalProviders/` — independent fiscal-provider contract and registry.
  - `ksef` is registered as `planned`; there is intentionally no API/auth/XML/network code in Stage 1.

## Warehouse Order safety rule

The current warehouse `Order.items[].price` does not encode whether the value is NET or GROSS and does not carry a VAT contract. Stage 1 **must not guess** either value.

`warehouse_order` therefore requires explicit `quantityMode` (`ordered` or `fulfilled`) and leaves `priceBasis` as `unknown` unless the caller/policy supplies it. A draft with unknown pricing/VAT or missing legal amounts cannot cross the finalization boundary.

## Finalization boundary

Finalization:

1. normalizes canonical data;
2. rejects incomplete/ambiguous line pricing and inconsistent totals;
3. builds deterministic canonical JSON;
4. hashes it with SHA-256;
5. stores one `InvoiceSnapshot`;
6. moves `Invoice.status` from `draft` to `finalized`.

Fiscal providers will consume the snapshot, never live `Order`/`Product` data. A later edit to a product, shop or order therefore cannot silently mutate a legally finalized invoice.

## What is deliberately NOT implemented yet

- KSeF auth/token/certificates;
- FA(3) XML generation/XSD validation;
- KSeF online/offline submission;
- UPO/status/reconciliation;
- inbound KSeF invoices;
- automatic VAT/policy inference from warehouse prices;
- invoice HTTP/UI workflows.

Those belong to later stages on top of this boundary.
