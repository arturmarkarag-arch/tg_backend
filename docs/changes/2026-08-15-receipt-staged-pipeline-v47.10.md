# V47.10 — staged receipt pipeline

## Contract

Current regular receipt flow is now enforced as:

```text
photo + totalQty
  -> price + qtyPerPackage
  -> routing
  -> confirm / commit
```

## Server guarantees

- New ReceiptItem defaults `qtyPerPackage` to `null`; an untouched row cannot look prepared accidentally.
- `assertItemReadyForRouting()` gates Stage 3 with photo, received quantity, price > 0 and qtyPerPackage >= 1.
- `/receipts/:id/items/:itemId/routing` includes the readiness fields in its atomic draft update predicate, closing readiness-vs-routing races.
- Cached legacy create payloads may only set a legacy destination when the same payload already satisfies preparation.
- Confirm checks Stage 2 before reporting route completeness.
- Existing legacy fields and historical receipts remain intact; there is no destructive migration.
