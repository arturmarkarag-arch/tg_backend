# V48.19 — Data/State Architecture Foundation

Date: 2026-08-16
Baseline: reconstructed full V48.18 server/client
Schema migration: none
Database mutation during development/audit: none

## Goal

Turn the Data/State audit into enforceable architecture rather than fixing only the visible "Без продавця" symptom.

The release establishes two boundaries:

```text
READ: CURRENT truth != SESSION/HISTORY display
WRITE: one business transition = one canonical command
```

## Server

### Current topology policy

Added `utils/shopOperationalState.js`:

- one role vocabulary for shop assignment (`seller`, `admin`);
- `assignedCount/hasAssigned`;
- `operationalCount/hasOperationalUser`;
- operational user/shop issue vocabulary;
- assignment target assertions.

### Shop status projection

Added `services/shopStatusProjection.js`:

- readiness projection;
- current-session projection;
- explicit `currentAssignment` and `sessionParticipants` split;
- assignment-derived conflict flags never read presentation seller rows.

`/delivery-groups/:groupId/shop-status` now returns explicit `view` and uses the shared projection builders.

`/shops` also exposes `currentAssignment`, so Settings and picking speak the same current-topology contract.

### Assignment write authority

Existing `migrateSellerShop()` remains canonical; V48.19 hardens and reuses it:

- target Shop is re-read inside the command's Mongo session;
- role is validated at the command boundary;
- ShopTransfer initial assignment no longer raw-writes `User.shopId`;
- `POST /users` is create-only;
- generic user PATCH refuses any raw shop transition fallthrough;
- seller/admin assignment semantics are consistent;
- soft-removed re-registration passes the intended new role to the canonical command.

### Inactive Shop semantics

`Shop.isActive=false` blocks new:

- assignment;
- normal ordering writes;
- supplement seller writes;
- catalog-reviewed session events.

### Block move authority

Added `services/blockMoveCommand.js`.

HTTP and Socket block moves now share:

- one Mongo transaction;
- optimistic Block version checks;
- one product membership mutation;
- one PickingTask position reconciliation.

The warehouse client sends expected source/target versions on Socket moves.

## Client

- shop-status query keys include projection view;
- group prefix invalidates current + readiness together;
- UpcomingSessionView uses the same visual dashboard with `view=readiness`;
- active session explicitly uses `view=current`;
- `Без продавця` reads `currentAssignment.hasAssigned`;
- assigned-but-unavailable has a separate warning;
- seller action modal gets `currentAssignment.assignedUsers`, never historical display rows;
- an empty historical/session roster no longer renders `Не призначено` when current assignment exists;
- Socket block move sends optimistic versions and displays human server error message.

## Tests / release gates

Added server:

- `tests/shopOperationalState.test.js`
- `tests/dataStateArchitectureV4819.contract.test.js`
- `scripts/checkDataStateArchitectureV48_19.js`
- `npm run test:data-state:v48.19`

Added client:

- `src/dataStateArchitectureV4819.contract.test.js`
- `scripts/checkDataStateArchitectureV48_19.mjs`
- `npm run test:data-state:v48.19`

Updated stale contracts that previously required Preparation to use the current-session cache/query.

New static checkers are included in ordinary `test:release:static`.

## Offline verification in this environment

Completed:

- server V48.19 data/state static: PASS;
- full server release static: PASS 20/20;
- client V48.19 data/state static: PASS;
- full client release static: PASS 13/13;
- V48.18 harness static regression: PASS 70/70;
- pure current-assignment/projection runtime probe: PASS;
- Node syntax check on all changed/new server JS: PASS;
- TypeScript parser on all changed/new client JS/JSX/MJS: PASS.

Not claimed here:

- full Vitest server/client suite (no project node_modules in the reconstruction environment);
- live Atlas E2E/race/MASS;
- browser visual smoke.

Those remain required before release GO.

## Deferred audit findings

V48.19 establishes the architecture boundary and closes the direct P1 class around current assignment/read models and block mutation authority. The following remain deliberate later phases:

- supplement topology move/delete policy;
- Product -> ShopProduct durable projection repair;
- legacy cart/current-order separation;
- buyerSnapshot field-level frozen/live documentation enforcement;
- active-order/live-item predicate consolidation;
- further decomposition of deliveryGroups.js.

See `docs/architecture/data-state-contract-v48.19.md`.
