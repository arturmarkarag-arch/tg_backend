# Invoice Core — Stage 2

Stage 2 turns the provider-neutral Stage 1 domain into a usable invoice creation layer. It still does **not** submit anything to KSeF.

## Boundary

```text
SOURCE PROVIDERS
      |
      v
INVOICE CREATION LAYER
      |
      +--> LegalEntity issuer snapshot/defaults
      +--> pricing/VAT normalization
      +--> draft validation
      |
      v
INVOICE CORE
      |
      v
immutable InvoiceSnapshot
      |
      v
FISCAL PROVIDERS (KSeF remains planned in Stage 2)
```

## LegalEntity

`LegalEntity` owns issuer identity and defaults: legal name, tax id, address, bank accounts, default currency, payment defaults and numbering series. Exactly one entity may be marked `isDefault=true`.

A draft receives a **snapshot** of the selected LegalEntity in `invoice.seller`. Updating the LegalEntity later does not retroactively rewrite an existing invoice draft/finalized snapshot. A generic invoice PATCH also cannot silently swap the issuer.

## Creation API

All Stage 2 invoice endpoints are admin-only.

- `GET /api/invoices/meta`
- `GET/POST /api/invoices/legal-entities`
- `GET/PATCH /api/invoices/legal-entities/:id`
- `POST /api/invoices/preview`
- `POST /api/invoices`
- `GET /api/invoices`
- `GET/PATCH /api/invoices/:id`
- `POST /api/invoices/:id/finalize`

`POST /preview` builds a normalized draft and returns blockers without persistence. `POST /` persists the draft and accepts an optional explicit idempotency key.

## Warehouse Order source

The provider requires an explicit `quantityMode`:

- `ordered` — invoice requested quantities;
- `fulfilled` — invoice actually packed/fulfilled quantities; cancelled/skipped/voided lines are excluded.

It never guesses whether `Order.items[].price` is NET or GROSS and never guesses VAT. Pricing must be provided by `pricingByLineId`, `pricingByProductId`, or explicit defaults. Ambiguous lines remain blocked from finalization.

## Pricing

Monetary arithmetic does not use JS floating-point totals. Decimal strings are converted to integer/fraction arithmetic and rounded to 2 decimal places. Both NET-basis and GROSS-basis pricing are supported.

## Numbering

An invoice number is allocated only during finalization, in the same Mongo transaction as immutable snapshot creation. Counters are scoped by:

`legalEntity + invoiceType + issueYear + series`

The resulting default format is `SERIES/SEQUENCE/YEAR` and is configurable per LegalEntity.

## Stage 2 non-goals

- no KSeF authentication;
- no FA(3) XML;
- no online/offline KSeF session;
- no UPO;
- no KSeF QR;
- no fiscal credential storage.

Those belong to Stage 3+ and must consume only finalized invoice snapshots.
