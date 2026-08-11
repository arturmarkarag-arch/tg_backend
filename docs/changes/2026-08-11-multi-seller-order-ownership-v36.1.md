# 2026-08-11 — Multi-seller + Order ownership correction v36.1

## Corrected assignment contract

- One shop may have multiple sellers.
- Seller presence alone is never a shop conflict.
- One seller has at most one active Order per `(buyer, shop, orderingSession)`.
- The DB unique index remains `(buyerTelegramId, shopId, orderingSessionId)` for active orders.
- A pre-picking conflict exists only when one shop has active current-session Orders from 2+ distinct authors.
- Shop transfer approval never evicts an existing seller from the target shop.

## Order ownership freeze

- `buyerTelegramId` is historical author provenance.
- `shopId + buyerSnapshot + orderingSessionId` identify the shop/session that owns the Order operationally.
- Ordinary seller reassignment/unassignment may move/park an active Order only while ordering is still open and picking is pending.
- At `OrderingSession.closeAt`, or as soon as picking leaves `pending`, the Order ownership is frozen.
- After freeze, changing `User.shopId` does not change old Order ownership.
- Dedicated current-session conflict repair is the only explicit pre-picking override and is audit-marked as `ownershipRepair`.

## UI cleanup

- Removed “one shop — one seller” help/warnings.
- Multiple sellers no longer paint a shop row yellow or produce a warning by themselves.
- Picking conflict copy now refers to multiple active Order authors, not multiple assigned sellers.
- Transfer-request UI states that existing target-shop sellers remain assigned.
