# 2026-08-08 — final pre-prod OOS reconciliation fix

## Found during final audit

The latest saved MASS report reached terminal picking with no `conflict_retry`, but
finished with 41 completed `out_of_stock` tasks whose `archiveReconciled` flag was
still false. The product archival itself succeeded; the canonical crash-recovery
signal was never consumed by `archiveProduct()`.

## Fix

- `archiveProduct()` now marks the exact unreconciled OOS task snapshot as
  `archiveReconciled:true` inside the SAME Mongo transaction as product archival.
- The idempotent already-archived path also consumes stale OOS recovery signals.
- The orphan-recovery sweep heals legacy/pre-fix cases where Product is already
  archived but the task signal is still unreconciled.
- Added `pickingOosArchiveReconciliation.contract.test.js` so this write cannot
  silently disappear again.

## Unchanged

- OOS cause remains `completionReason:'out_of_stock'`; `items[].packed` is not used
  to infer cause.
- Session-finalize contention lane stays in place.
- MASS final assertion stays strict: unreconciled OOS must equal zero.
- Telegram ordering-open notifications are unchanged.

## Packaging safety

`.env` / `.env.*` files are excluded from the distributable server package.

## Required acceptance before production picking

Run on the guarded TEST MongoDB:

1. `npm test`
2. `npm run test:live:e2e` (14/14)
3. `npm run test:live:e2e:mass` (0 failed, unreconciled OOS = 0, cleanup = 0)
4. build the client

The normal MASS harness intentionally disables Redis; a green run validates Mongo
and the single-process lock fallback, not the Redis lock branch.
