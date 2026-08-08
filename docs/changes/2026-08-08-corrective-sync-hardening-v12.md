# 2026-08-08 — corrective sync hardening v12

## Why
Audit of the merged 2026-08-08 client/server package found three regressions/gaps:
1. v11 picking finalize lane had been overwritten by the older v10 `pickingService.js`;
2. `/v1/telegram/mini-app/state` was described as navigation-only but still rewrote legacy `cartState.orderItems/orderItemIds` with empty values;
3. an already in-flight `GET /blocks/:id` could resolve after an authoritative `block_updated` socket patch and roll the cache back to an older block version.

A smaller UI regression was also closed: OOS toast delivery no longer depends on the orders-tab quantity poller being active.

## Server changes
- Restored v11 per-ordering-session `picking:finalize:<orderingSessionId>` commit lane around normal task completion and OOS reconciliation.
- Kept Mongo transaction + transient retry; the lane only shapes contention, it does not replace transactional correctness.
- Fixed process-local lock queue cleanup so per-session fallback keys do not accumulate forever when Redis is disabled.
- Made `POST /v1/telegram/mini-app/state` truly navigation-only: it no longer reads/writes `cartState.orderItems` or `cartState.orderItemIds`.
- Added authenticated private socket room `user_<telegramId>` and targeted `user_product_archived` event for buyers whose order item was cancelled by archive/OOS.
- Removed `scripts/.env` from the distributable package. `.gitignore` already excludes `.env` / `.env.*` at any depth.

## Client changes
- Navigation-state POST payloads no longer send dead `orderItems/orderItemIds` fields.
- `block_updated` now cancels an in-flight exact block query before applying the socket snapshot and ignores older socket versions.
- If a paginated `blocks` query was in-flight during the event, it is cancelled and refreshed once after the patch; normal socket updates remain zero-HTTP.
- Added targeted `user_product_archived` listener so OOS notification works on any mini-app tab without re-enabling background order polling.

## Preserved contracts
- `Block.productIds` partial unique index and critical index sync.
- live E2E DB-host guard.
- v10 6-retry exponential+jitter Mongo conflict budget.
- client retry only for `409 + conflict_retry`.
- strict MASS assertion requiring HTTP 200 task finalization.

## Required verification
1. unit tests;
2. functional live E2E 14/14;
3. MASS live E2E 100 sellers / 240 products / 12 workers, with 0 `conflict_retry` responses;
4. browser: same-block reorder => 0 `GET /api/blocks/:id` in normal socket path;
5. browser: force/focus a block refetch, reorder while it is in-flight, verify old HTTP response cannot revert the socket version;
6. mini-app: collapse/resume repeatedly => no `cart_stale`; legacy cart snapshot remains untouched;
7. OOS while seller is on a non-orders tab => targeted toast still appears.
