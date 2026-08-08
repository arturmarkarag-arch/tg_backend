# v21 — Picking ordered-products pagination

- `GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products` now accepts `limit` and `offset`.
- Defaults to 24 items and clamps a request to 48 items maximum.
- Response includes `total`, `limit`, `offset`, and `hasMore`.
- Current-session, current-shop, active-order and cancelled/skipped filtering rules are unchanged.
