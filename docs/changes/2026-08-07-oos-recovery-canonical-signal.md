# 2026-08-07 — OOS recovery uses completionReason

## Problem

The orphan OOS archive sweep and archive restore inferred an out-of-stock completion from
`status:'completed' + items.packed:false`. That mixed two different concepts:

- `PickingTask.status` — lifecycle (`pending` / `locked` / `completed`)
- `items[].packed` — per-shop fulfilment
- `completionReason` — why the task reached `completed`

This could misclassify a normal completion containing `actualQty:0` as OOS, ignore a real OOS
whose listed shops were all already served, and made system-archive tasks look like OOS.

## Change

Added `utils/pickingOosRecovery.js` with one canonical predicate:

- `status: 'completed'`
- `completionReason: 'out_of_stock'`
- `archiveReconciled: { $ne: true }`

Both orphan-sweep reads and archive-restore consumption use the same helper, so the two sides
cannot drift independently.

No `PickingTask.status` semantics were changed.

## Touched

- `utils/pickingOosRecovery.js`
- `services/pickingService.js`
- `routes/archive.js`
- `models/PickingTask.js` (documentation only)
- `routes/products.js` (tripwire comment only; behaviour unchanged)
- `tests/pickingOosRecoveryFilter.test.js`

## Intentionally not changed

- `archiveProduct` lifecycle/status behaviour
- order packed/cancelled semantics
- generic product PATCH behaviour
- warehouse test harness issue (`items: []`)
