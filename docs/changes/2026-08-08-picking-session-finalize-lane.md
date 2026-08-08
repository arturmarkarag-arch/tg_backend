# Picking session finalization lane — 2026-08-08

## Why

The live MASS E2E (100 sellers / 240 products / 12 warehouse workers) still produced an HTTP `409 conflict_retry` after increasing Mongo transaction retries to 6 with exponential backoff + jitter. This proves the dominant problem is a shared-document write hotspot, not an insufficient retry count: different PickingTasks in the same session update many of the same embedded Order documents at the same time.

## Change

Physical picking remains concurrent. Only the final fulfilment commit is serialized per `orderingSessionId` with the existing `withLock()` abstraction:

- normal `completePickingTask`: task + Order item transaction runs inside `picking:finalize:<orderingSessionId>`;
- OOS phase 1 and its `archiveProduct` phase run in the same session finalization lane;
- completed-OOS crash retry archives under the same lane.

The Mongo transaction remains the correctness boundary. The lock only shapes contention so concurrent pickers do not repeatedly abort each other's transactions.

Lock settings:

- TTL: 120s
- acquisition wait: 30s
- Redis-backed when Redis is configured;
- process-local fallback in supported single-process mode.

## Intentionally unchanged

- PickingTask lifecycle/statuses
- Order terminal semantics
- session closure blockers/warnings
- forward walking / worker barrier
- OOS canonical recovery signal
- client `409 + conflict_retry` narrow retry from v10
- MASS assertion remains strict: worker finalization must return HTTP 200

## Acceptance

Re-run both suites on the guarded TEST cluster:

1. `npm run test:live:e2e` → 14/14
2. `npm run test:live:e2e:mass` → 0 failed assertions, no `conflict_retry`, session completed, 0 leftovers

Do not increase retry count further if the MASS test still leaks `conflict_retry`; inspect the remaining write set instead.
