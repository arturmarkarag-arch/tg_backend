# V47.7 — Core flow hardening (server)

Date: 2026-08-15

## Seller order session fence
`POST /v1/orders/upsert-item` requires the client's `orderingSessionId`. If it is missing or no longer matches the group's current server session, the write is rejected with `409 ordering_session_changed` and the current session id. This mirrors the existing mini-app navigation fence and prevents both an old Telegram/WebView tab and an old cached client bundle from silently writing stale intent into a newly opened weekly session.

## Seller order serialization
Mutations of one seller/shop/session active `Order` are serialized with `withLock(order:upsert:...)`. This protects the shared Order document and the first-item creation path when different product requests arrive concurrently. The existing database unique index remains the final backstop.

## Ordering status
`GET /delivery-groups/ordering-status` now returns `orderingSessionId`, resolving/materialising the current session once and reusing it for the response helpers.

## Supplement picking lease
- Added `POST /api/supplement/offers/:offerId/heartbeat`.
- Claim, heartbeat, release, and complete use the same logical `withOfferLock` critical section.
- A real packed toggle refreshes `lockedAt` as proof of liveness.
- Completion validates the current owner inside the offer lock, removing the previous read-before-lock TOCTOU race.

## Compatibility
No destructive migration. Existing orders, picking tasks, supplement offers, and normal picking contracts remain intact.
