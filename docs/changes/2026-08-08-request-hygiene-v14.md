# 2026-08-08 — Request hygiene v14

## Goal
Remove unrelated background HTTP fan-out discovered from a production Network dump without weakening picking correctness.

## Server changes
- `POST /api/v1/telegram/mini-app/state` is now strictly private navigation state.
- Removed `shop_status_changed` emission from navigation saves. A seller changing `currentIndex/currentPage` no longer wakes picking dashboards.
- Real order/shop/session mutations retain their existing domain events.

## Client changes
- `ShopStatusTable` no longer invalidates `/api/delivery-groups` on `shop_status_changed`; that endpoint has its own `delivery_groups_updated` event.
- Socket-driven `shop_status_changed` refreshes are coalesced for 250 ms to absorb bursts from many simultaneous sellers.
- Initial socket connection no longer duplicates the mount GETs; reconnect still performs catch-up.
- `usePickingSession` no longer forces a second 5 s poll of the same shop-status query. `ShopStatusTable` owns socket-first + 10 s disconnect fallback.
- Settings now listens to `user_shop_changed` instead of `user_order_updated` before refreshing shop lists.
- Incoming Products uses `incoming_updated` as primary refresh and polls every 15 s only while the socket is disconnected.
- Seller supplements skip the redundant refresh on first socket connect; reconnect still catches up.

## Intentionally retained polling
- Picking `queue-stats`: 5 s while Picking page is active. This carries session lifecycle/task counters not covered by one complete socket event in every path.
- Picking schedule: 15 s while Picking page is active.
- Conflict panel: 15 s only while conflict UI is mounted.
- Supplement picking: 5 s only while the list/card is open.
- Locked tasks: 15 s only while waiting for locks.
- Picking heartbeat/progress sync: active-task correctness, not ambient polling.
- Nav badges: one aggregated request/minute.

## Verification
- Server JS syntax: 167/167 `node --check` OK.
- Client non-JSX JS syntax: 55/55 `node --check` OK.
- Static request-hygiene contracts passed.
- Added regression tests for navigation-state no-broadcast and client request-hygiene contracts.
- Full client build/unit suite was not run in the artifact environment because package dependencies were not available there.
