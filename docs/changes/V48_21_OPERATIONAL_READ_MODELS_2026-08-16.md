# V48.21 — Operational Read Models

Date: 2026-08-16  
Base: V48.20

## Goal

Finish F-16 from the Data/State architecture audit by moving operational GET-state construction out of `routes/deliveryGroups.js` into named, read-only projection services.

## Implemented

- Added `services/readModels/` as the canonical operational query layer.
- `view=readiness` now structurally depends only on CURRENT Shop/User topology.
- Current-session Shop status has a dedicated projection loader.
- Seller `/ordering-status` aggregation moved to a pure read model.
- Delivery-group list/summary/session-summary reads moved out of the route.
- Lazy ordered-products disclosure moved to a dedicated current-session read model.
- `routes/deliveryGroups.js` reduced from ~1441 lines before the read-model extraction to under 700 lines while preserving write endpoints there for later command-side ownership.
- Snapshot-only Orders now use the same Shop resolver for both Shop grouping and `hasOrder` participant status.
- `CatalogReview` roster is skipped when there is no current OrderingSession.

## Architecture guarantee

All V48.21 read-model modules are scanned for domain mutation/session materialisation primitives. A GET read model cannot call `getOrCreateSessionId()`.

## Tests/checks

- Added `tests/operationalReadModelsV4821.contract.test.js`.
- Added `scripts/checkOperationalReadModelsV48_21.js`.
- Added `npm run test:read-models:v48.21`.
- Added V48.21 checker to `test:release:static`.
- Updated older source-contract tests/checkers so they follow the new architecture boundary instead of requiring implementation text to remain inside the Express route.

## Runtime scope

No database schema change. No migration. No DB operation performed during implementation. Client API/DTO contract intentionally unchanged.
