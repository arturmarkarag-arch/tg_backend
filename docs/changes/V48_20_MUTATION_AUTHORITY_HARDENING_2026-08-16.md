# V48.20 — Mutation Authority Hardening

Date: 2026-08-16  
Base: V48.19 Data/State Architecture Foundation

## Goal

V48.19 separated CURRENT/SESSION/HISTORY/DERIVED/DISPLAY on the read side. V48.20 hardens the corresponding write side:

> one business transition = one implementation = the same mandatory side effects regardless of HTTP, Socket.IO or surrounding admin/registration workflow.

No Mongo schema migration was introduced.

## User -> Shop

Added `services/shopAssignmentCommand.js` as the ordinary application command boundary.

- ordinary admin edit uses `assignUserToShopCommand` / `unassignUserFromShopCommand`;
- seller self-service assignment uses the same command;
- order conflict repair uses the same commands with explicit frozen-order repair opt-ins;
- assignment commands own a per-user distributed lock + Mongo transaction;
- `migrateSellerShop()` / `unassignSellerAndPark()` remain transaction-aware primitives for wider atomic workflows;
- all callers publish one structured assignment transition after commit;
- dashboard publication is based on topology change, not on whether an Order happened to move;
- initial assignment of a newly-created account publishes the same CURRENT topology transition.

Wider transactions (ShopTransfer, bulk edit, invite redeem, soft remove, registration/reactivation) retain low-level primitives inside their transaction and use the shared post-commit publisher. Bulk editing resets transition metadata on every Mongo transaction callback attempt to remain retry-safe.

## Shop topology

Added `services/shopTopologyCommand.js`.

`PATCH /api/shops/:id` is now transport-only for topology/config fields.

The command owns:

- `Shop.name/address/cityId/deliveryGroupId/isActive`;
- per-Shop distributed lock;
- one Mongo transaction;
- group-change current-session safety guard;
- active Order buyerSnapshot identity propagation;
- pending/locked PickingTask shop-name propagation;
- post-commit cache + Socket publication.

The group-change guard performs a read-only `OrderingSession.findOne({groupId, openDate})`. It does not materialize a session as a validation side effect.

Supplement group-move/delete policy remains intentionally deferred (F-09/F-10).

## Product -> Block

Expanded `services/blockMoveCommand.js` into the ordinary physical membership command boundary:

- repair;
- move;
- remove;
- place.

Added `services/blockMembershipPrimitives.js` for wider transactions:

- prune invalid ids;
- detach product from all blocks;
- append products to a block document.

All runtime `Block.productIds` writes are now confined to these two modules.

Updated:

- `/blocks` HTTP operations;
- product block-photo batch creation;
- product archive;
- block scrub/repair;
- warehouse test fixture path.

Every physical removal/reorder path now repairs derived `PickingTask.positionIndex` through the shared task-builder reconciliation.

## Tests / guards

Added:

- `tests/mutationAuthorityV4820.contract.test.js`;
- `scripts/checkMutationAuthorityV48_20.js`;
- package script `test:mutation-authority:v48.20`.

Updated V48.19 Data/State source contracts to expect the stronger application-command boundary.

Release static aggregate now includes V48.20.

## Explicitly deferred

V48.20 does not close:

- F-09 supplement topology move policy;
- F-10 supplement delete/reference policy;
- F-11 durable Product -> ShopProduct mirror convergence;
- F-12 legacy cartState leakage;
- F-15 duplicated active-order/live-item predicates;
- F-16 remaining deliveryGroups read-model decomposition.

These are not marked green by this release.

## Verification in reconstructed environment

The source tree has no installed `node_modules`, therefore full Vitest was not claimed here.

Completed source/static checks are recorded in the external V48.20 report and should be rerun after any subsequent change before packaging.
