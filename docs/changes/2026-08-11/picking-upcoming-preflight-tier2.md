# Picking upcoming preflight

Date: 2026-08-11

## Server contract

- `/api/delivery-groups` now publishes `nextOrderingOpenAt`, calculated by the canonical Warsaw scheduling utility.
- `GET /api/delivery-groups/:groupId/shop-status?view=readiness` is a read-only next-cycle preparation view.
- Readiness mode does NOT create or reset an `OrderingSession`.
- It returns current shop/seller assignment topology only; prior-session orders, review marks and stale-order data are intentionally excluded.
- Legacy multiple-seller assignments remain visible through `hasMultipleSellers` so they can be repaired before the next cycle.

## Tests/contracts

- Added `tests/pickingUpcomingReadiness.contract.test.js`.
- Added the contract to `npm run test:v35:session`.
- Full Vitest execution was not possible in this environment because dependencies are not installed and the npm registry/cache is incomplete.
