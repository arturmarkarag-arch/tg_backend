# Mutation Authority Contract — V48.20

Date: 2026-08-16  
Status: architecture contract for current runtime  
Base: V48.19 Data / State Contract

## 1. Purpose

V48.19 separated kinds of truth:

```text
CURRENT -> SESSION/HISTORY -> DERIVED -> DISPLAY
```

V48.20 defines the matching **write-side architecture**:

```text
TRANSPORT
   ↓
APPLICATION COMMAND
   ↓
TRANSACTION-AWARE DOMAIN PRIMITIVE
   ↓
MONGO COMMIT
   ↓
POST-COMMIT PUBLICATION / DERIVED REPAIR
```

The rule is:

> One business transition has one authoritative implementation and one side-effect contract, regardless of whether it was initiated by HTTP, Socket.IO, Telegram/admin workflow, or another internal orchestration.

Routes and socket handlers may validate transport-specific input and shape responses/events. They must not independently reimplement domain mutation logic.

This contract does **not** introduce a new database schema or event sourcing.

---

## 2. Vocabulary

### Application command

Owns the ordinary business transition end-to-end:

- serialization/lock where required;
- transaction boundary;
- validation that must be authoritative at commit time;
- invocation of low-level domain primitives;
- structured transition result;
- post-commit cache/realtime publication.

Examples:

```text
assignUserToShopCommand()
unassignUserFromShopCommand()
updateShopTopologyCommand()
moveProductBetweenBlocks()
placeProductInBlock()
removeProductFromBlock()
```

### Transaction-aware primitive

A lower-level mutation that may be called **inside a wider atomic workflow** which already owns a Mongo transaction.

Examples:

```text
migrateSellerShop()
unassignSellerAndPark()
detachProductFromAllBlocks()
appendProductsToBlockDocument()
pruneInvalidBlockProductIds()
```

A primitive does not publish cache/socket state before its enclosing transaction commits.

### Wider atomic workflow

A workflow where assignment/block membership is only one part of a larger transaction and therefore cannot call a command that opens a nested independent transaction.

Examples:

- ShopTransfer approval + request resolution;
- shop bulk seller edit;
- account soft removal;
- shop invite redeem;
- registration/reactivation;
- product archival;
- batch product creation into a block.

Such workflows may call primitives directly **only inside their own transaction** and must publish/repair after commit using the shared publication contract.

---

## 3. Post-commit rule

MongoDB is authoritative.

The following are post-commit effects:

- cache invalidation;
- Socket.IO notifications;
- derived realtime refresh messages;
- non-authoritative projection refreshes.

They must never occur inside an uncommitted transaction because another worker could immediately repopulate cache from pre-commit Mongo state.

Therefore:

```text
Mongo transaction COMMIT
        ↓
cache invalidation
        ↓
Socket publication
```

Cache/socket failure after commit must not turn a successful domain mutation into a rollback or false HTTP failure.

---

## 4. Canonical User -> Shop mutation authority

### CURRENT truth

```text
User.shopId
```

remains the CURRENT source of truth for assignment.

### Ordinary commands

Canonical application service:

```text
services/shopAssignmentCommand.js
```

Exports:

```text
assignUserToShopCommand()
unassignUserFromShopCommand()
publishShopAssignmentTransition()
buildInitialAssignmentTransition()
normalizeAssignmentTransition()
```

Ordinary routes must not call `migrateSellerShop()` or `unassignSellerAndPark()` directly.

### Serialization

Assignment commands serialize by:

```text
user:<telegramId>:shop
```

using the existing distributed `withLock()` implementation. With Redis enabled this is cross-worker; single-process development uses the process-local fallback.

### Atomicity

An ordinary assignment command owns one Mongo transaction containing:

```text
optional profile/user patch
+ authoritative current User read
+ target Shop read/validation
+ migration or unassignment primitive
```

Post-commit publication happens only after `withTransaction()` resolves.

---

## 5. Assignment transition DTO

Assignment side effects must not depend on whether an Order happened to move.

Canonical transition metadata:

```json
{
  "fromShopId": null,
  "toShopId": null,
  "prevGroupId": null,
  "newGroupId": null,
  "sellerTelegramId": null,
  "assignmentChanged": false,
  "orderChanged": false
}
```

Additional fields such as `movedOrder`, `parkedOrderIds`, or `updatedUser` may exist, but topology publication uses the explicit transition fields above.

This fixes the old failure mode:

```text
seller changed Shop
+ no active Order moved
=> CURRENT topology changed
=> dashboard still MUST refresh
```

---

## 6. Assignment publication contract

`publishShopAssignmentTransition()` is the shared post-commit publisher.

When assignment topology changes it:

1. invalidates old/new Shop cache;
2. emits `shop_status_changed` to every affected delivery group;
3. emits `delivery_groups_updated` when group membership changed;
4. emits `user_order_updated` only when Order state also changed.

Transport-specific notifications such as `user_shop_changed` may still be emitted by the transport, but they do not replace canonical group/cache publication.

---

## 7. Wider assignment transaction exceptions

The following may use low-level primitives directly because they already own a larger transaction:

```text
ShopTransfer approval
bulk sellers update
shop invite redeem
soft remove
registration/reactivation
```

Required pattern:

```text
begin wider transaction
  mutate request/token/account
  call migrateSellerShop() / unassignSellerAndPark()
  capture transition metadata
commit wider transaction
publishShopAssignmentTransition(capturedTransition)
```

### Transaction retry safety

Mongo `withTransaction()` may rerun its callback after a transient conflict.

Any array/list of post-commit transition metadata populated inside the callback must be reset at the beginning of each callback attempt.

Current bulk-seller invariant:

```js
assignmentTransitions.length = 0;
```

before collecting transitions for that transaction attempt.

This prevents events from an aborted retry attempt from being published after the successful commit.

---

## 8. Initial assignment

A genuinely new User has no previous CURRENT assignment or active Order ownership to migrate.

It may therefore be created with an initial valid `shopId`, but after commit it must still publish the same topology transition contract through:

```text
buildInitialAssignmentTransition()
→ publishShopAssignmentTransition()
```

`POST /api/users` remains create-only for an existing Telegram identity. It is not an alternate assignment/update API.

---

## 9. Shop CURRENT topology authority

Canonical service:

```text
services/shopTopologyCommand.js
updateShopTopologyCommand()
```

It owns updates to:

```text
Shop.name
Shop.address
Shop.cityId
Shop.deliveryGroupId
Shop.isActive
```

### Serialization

Shop topology edits serialize through:

```text
shop:<shopId>:topology
```

using `withLock()`.

This prevents two admin/process writes from independently reading the same old Shop topology and overwriting each other's transition semantics.

### Transaction ownership

The command transaction owns:

1. current Shop read;
2. City/DeliveryGroup validation;
3. current-session safety guard for group changes;
4. Shop mutation;
5. live-until-terminal Order buyerSnapshot identity propagation;
6. pending/locked PickingTask shop-name propagation.

### Important read/write boundary

Validation of a group change uses:

```text
OrderingSession.findOne({groupId, openDate})
```

It deliberately does **not** call `getOrCreateSessionId()`.

Editing Shop topology is a command, but its validation must not accidentally materialize an OrderingSession merely to ask whether current work exists.

### Current group-change policy

A Shop cannot move away from its current DeliveryGroup while that ordinary cycle has:

- an open ordering window; or
- active Shop Orders in the current OrderingSession.

Supplement topology policy is intentionally not defined here; see deferred F-09/F-10.

---

## 10. Product -> Block mutation authority

CURRENT physical truth:

```text
Block.productIds
Block.version
```

### Ordinary application commands

Canonical module:

```text
services/blockMoveCommand.js
```

Exports:

```text
repairBlockMissingProducts()
moveProductBetweenBlocks()
removeProductFromBlock()
placeProductInBlock()
```

HTTP and Socket transports must delegate to these commands instead of writing the array themselves.

### Transaction-aware primitives

Canonical module:

```text
services/blockMembershipPrimitives.js
```

Exports:

```text
pruneInvalidBlockProductIds()
detachProductFromAllBlocks()
appendProductsToBlockDocument()
```

These exist for workflows that already own a wider transaction, such as archive and batch receipt/product creation.

### Writer confinement invariant

Runtime writes to `Block.productIds` are allowed only in:

```text
services/blockMoveCommand.js
services/blockMembershipPrimitives.js
```

Routes, sockets, archive services, maintenance helpers and test routes may orchestrate but may not mutate physical membership arrays directly.

---

## 11. Derived PickingTask position repair

`PickingTask.positionIndex` is derived from physical Block membership/order.

Therefore every physical membership change which can shift positions must eventually invoke:

```text
refreshPickingTaskPositions()
```

V48.20 specifically closes previously divergent paths:

- HTTP move;
- Socket move;
- placement;
- removal;
- product archive/detach;
- block scrub/repair.

The derived repair is not allowed to depend on which transport performed the physical mutation.

---

## 12. Product activation / mirror boundary

Placement into a Block owns the CURRENT Product activation transition:

```text
Product.status -> active
firstBlockPlacedAt set once
```

The linked `ShopProduct` mirror remains a DERIVED projection.

V48.20 centralizes where placement asks for `syncMirror()`, but **does not claim durable convergence**. Fire-and-forget mirror durability remains finding F-11 and is intentionally deferred to V48.22.

---

## 13. Explicit non-goals / deferred contracts

V48.20 does not silently invent unresolved business policy.

### F-09 — Shop group move during supplement lifecycle

Still unresolved by policy.

Persisted `SupplementOffer.deliveryGroupId` / `SupplementRequest.deliveryGroupId` may represent a wave whose ownership must not be silently changed by a CURRENT Shop move.

### F-10 — delete Shop/DeliveryGroup with supplement references

Still unresolved by policy.

### F-11 — Product -> ShopProduct durable repair

Still open.

### F-12 — legacy cartState leakage

Still open.

### F-15 — active Order/live-item predicate consolidation

Still open.

### F-16 — deliveryGroups read-model decomposition

Still partial and belongs to V48.21.

---

## 14. Forbidden patterns after V48.20

New production code must not introduce:

```text
route/socket directly sets User.shopId for an existing active account
route/socket independently reimplements seller migration/unassignment
route directly mutates Shop.deliveryGroupId / Shop.isActive
route/socket directly mutates Block.productIds
cache/socket publication before transaction commit
UI/transport-specific mutation with missing canonical side effects
business publication conditional only on "movedOrder exists"
```

A wider transaction may call a documented primitive, but must follow the primitive + capture transition + post-commit publication pattern.

---

## 15. Verification contract

Source/static gate:

```bash
npm run test:release:static
node scripts/checkMutationAuthorityV48_20.js
```

Runtime suite in a normal dependency-installed environment:

```bash
npm run test:mutation-authority:v48.20
npm run test:data-state:v48.19
npm run test:picking:authority
npm run test:picking:readiness
npm run test:release
```

Live TEST Atlas verification remains owned by the hardened V48.18 harness and must be run only under the existing TEST safeguards.

No static/source pass substitutes for that runtime/live gate.
