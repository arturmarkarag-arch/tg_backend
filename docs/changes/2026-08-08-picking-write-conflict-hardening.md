# 2026-08-08 — Picking write-conflict hardening

## Why

The live mass E2E (100 sellers / 240 products / 12 warehouse workers) exposed a real MongoDB `WriteConflict` on task completion. The old picking transaction retry budget was 3 retries with linear 50/100/150ms waits. Under a burst, several PickingTasks update the same large Order documents, so one request exhausted that budget and surfaced `409 conflict_retry` to the worker.

## Server

- Picking transaction retry budget: 6 retries after the initial attempt.
- Backoff: exponential from 50ms, capped at 800ms, with jitter.
- Only transient transaction conflicts are retried; business errors are unchanged.
- If all server retries still exhaust, the existing `409 conflict_retry` remains the explicit contract.

## Client

- `completePickingTask` and `outOfStockPickingTask` silently retry only `409 + conflict_retry`, maximum 2 retries, with exponential backoff + jitter.
- Generic 409, validation, lock errors and network errors are NOT automatically retried.
- This is safe because `conflict_retry` is emitted only after Mongo reports the transaction conflict and the transaction did not commit.

## Mass E2E harness

- Normalizes task identity from Mongo (`_id`) and HTTP (`taskId`) through one `tid()` helper.
- Background pollers catch transport teardown cleanly.
- Worker failure always stops and joins pollers before the harness closes the HTTP server.
- Cleanup/report remains in `main().finally`; mass assertions are NOT relaxed for `conflict_retry`.
