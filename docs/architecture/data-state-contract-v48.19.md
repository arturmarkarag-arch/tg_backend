# Data / State Contract — V48.19

Date: 2026-08-16
Status: architecture contract for current runtime
Scope: Shop/User assignment, DeliveryGroup readiness/current-session projection, block moves, operational shop state.

## 1. Why this contract exists

The project has several legitimate kinds of truth that may describe the same human/shop/product differently at the same time:

1. **CURRENT** — present-tense master topology/configuration.
2. **SESSION** — facts owned by one OrderingSession / operational cycle.
3. **HISTORY / EVENTS** — immutable or historical facts about what happened.
4. **DERIVED** — server-computed business state from the above facts.
5. **DISPLAY** — UI-oriented projection/labels/merged rows.

The bug class fixed by V48.19 was caused by using a DISPLAY projection as if it were CURRENT business truth. In particular, CatalogReview can intentionally render a seller under the shop where the review happened, while User.shopId says where that person is assigned now. Both facts are valid, but they answer different questions.

The architectural rule is:

```text
CURRENT ──────────────┐
SESSION ──────────────┤
HISTORY ──────────────┼──> DERIVED ───> DISPLAY
                      │
DISPLAY ───── X ──────┘
```

DISPLAY must never redefine business truth or become a command target.

---

## 2. Canonical data classes

### CURRENT

Present-tense facts:

- `User.shopId` — current User → Shop assignment.
- `Shop.deliveryGroupId` — current Shop → DeliveryGroup assignment.
- `Shop.isActive` — whether the shop may participate in new operational work.
- `User.role`, `User.accountState`, `User.botBlocked` — current account/operational capability.
- `Block.productIds` + `Block.version` — current physical warehouse sequence.

### SESSION

Facts bound to one cycle:

- `OrderingSession` identity and lifecycle.
- `Order.orderingSessionId` and frozen ownership semantics.
- `PickingTask.orderingSessionId` and picking ownership/progress.
- session-specific `CatalogReview.sessionId`.

### HISTORY / EVENTS

Facts that describe what happened, not what is true now:

- `CatalogReview.shopId` — shop snapshot at the review event.
- `Order.history`.
- `User.history`.
- `ShopAuditLog`.
- picking/worker history.

### DERIVED

Server-computed state that must have one implementation:

- session phase / presentation mode;
- picking readiness;
- `currentAssignment`;
- `hasMultipleSellers`;
- `hasSellerOrderMismatch`;
- conflict flags and counts.

### DISPLAY

Presentation-only fields:

- `sessionParticipants`;
- compatibility `sellers` roster;
- `sellerName` / `sellerCount`;
- labels/text/merged historical rows.

Compatibility display fields are allowed to remain while clients roll forward, but no new business decision may depend on them.

---

## 3. Current assignment contract

Canonical implementation:

```text
server/utils/shopOperationalState.js
```

Assignable shop roles in V48.19:

```text
seller
admin
```

`warehouse` is not a shop-assigned operational role.

Canonical DTO:

```json
{
  "assignedUsers": [],
  "assignedCount": 0,
  "hasAssigned": false,
  "operationalCount": 0,
  "hasOperationalUser": false,
  "shopOperational": true,
  "shopOperationalIssues": []
}
```

`assigned` and `operational` are deliberately different facts.

Examples:

```text
seller assigned + active account + bot available
=> assigned=true, operational=true

seller assigned + botBlocked=true
=> assigned=true, operational=false

seller assigned + accountState=removed
=> assigned=true, operational=false

seller assigned + Shop.isActive=false
=> assigned=true, operational=false
```

The UI must not convert "assigned but unavailable" into "no seller".

---

## 4. Shop operational policy

Implemented V48.19 rule:

```text
Shop.isActive=false
```

means the shop cannot accept **new operational work**.

Blocked boundaries:

- new User → Shop assignment;
- normal ordering writes;
- supplement seller writes;
- new `catalog-reviewed` session event.

Historical records remain untouched.

A Shop must also have `deliveryGroupId` to be a valid assignment target.

`assertOperationalShop()` is enforced at the canonical assignment command boundary, not only in the caller. This prevents a stale route-level validation from authorizing a target that changed before commit.

---

## 5. Shop status read models

Canonical final projection boundary:

```text
server/services/shopStatusProjection.js
```

### Readiness projection

Used by next-session preparation.

Contains:

```text
CURRENT topology
+ operational readiness facts
```

Does NOT materialise or reuse session/history state merely because the admin opened preparation.

Contract:

```text
currentAssignment = CURRENT
sessionParticipants = []
orders = []
CatalogReview does not participate
```

### Current-session projection

Contains:

```text
CURRENT assignment
+ current OrderingSession Orders
+ session/history participant presentation
```

Contract:

```text
currentAssignment     = who is assigned NOW
sessionParticipants   = who should be rendered for THIS SESSION/HISTORY
```

They are allowed to differ.

Example:

```text
CURRENT:
  Ivan -> Shop B

HISTORY:
  Petro reviewed catalogue on Shop B and was later moved away

UI may show Petro as a historical participant,
but commands / "Без продавця" / multiple-assignment rules must read currentAssignment.
```

---

## 6. Client cache identity

`current` and `readiness` return intentionally different projections and therefore are different TanStack Query entities.

Canonical keys:

```text
['deliveryGroup-shop-status', groupId, 'current']
['deliveryGroup-shop-status', groupId, 'readiness']
```

Group-wide invalidation prefix:

```text
['deliveryGroup-shop-status', groupId]
```

This prevents the previous-session/current-session response from occupying the readiness cache entry or vice versa.

---

## 7. UI command/read separation

### Read-only display

May use:

```text
sessionParticipants
sellers                 // compatibility alias
sellerName               // compatibility display field
catalogReviewedAt
movedAway
```

### Business warnings

Must use:

```text
currentAssignment.hasAssigned
currentAssignment.hasOperationalUser
hasMultipleSellers
hasSellerOrderMismatch
```

### Commands targeting people

Must use:

```text
currentAssignment.assignedUsers
```

Never use `sessionParticipants` / historical `sellers` as the target list for reassign/unassign commands.

---

## 8. Canonical User -> Shop write authority

Existing correct domain command remains the authority:

```text
migrateSellerShop()
```

Unassignment authority:

```text
unassignSellerAndPark()
```

V48.19 removes the known bypasses instead of inventing a second assignment engine.

### Allowed flows

- dedicated admin shop assignment;
- generic user edit;
- ShopTransfer approval;
- bulk seller assignment;
- seller self-transfer/invite;
- soft-removed account re-registration.

All assignment changes of an existing account must reach canonical migration/unassignment.

### Create-only exception

A truly new User may be created with an initial valid shop because there is no previous assignment/order state to migrate.

`POST /api/users` is now create-only. It is no longer an alternate update endpoint for an existing `telegramId`.

### Soft-removed re-registration

A removed account may return under a different intended role. Canonical assignment validates the **intended new role**, not the stale role stored on the removed row.

---

## 9. Order ownership boundary during User moves

V48.19 does not change the existing strong rule:

- before ownership freeze, canonical migration may move the seller's current active order when permitted;
- after ownership freeze, ordinary User.shopId changes do NOT move the Order;
- explicit conflict-repair paths remain the only opt-out.

Old/session-owned Order state does not become CURRENT User assignment state.

---

## 10. Canonical Product -> Block move command

Canonical command:

```text
server/services/blockMoveCommand.js
moveProductBetweenBlocks()
```

Transport-independent responsibilities:

1. validate source/target/index;
2. check optimistic `Block.version` values;
3. mutate `Block.productIds` transactionally;
4. increment block versions;
5. map unique-product conflict to stable domain error;
6. reconcile `PickingTask.positionIndex` through `refreshPickingTaskPositions()`;
7. return position changes for post-commit notification.

Both:

```text
POST /api/blocks/move
Socket.IO move_item
```

must delegate to this command.

Socket is transport/notification, not a second warehouse mutation implementation.

---

## 11. Explicit decisions in V48.19

### D-01 Admin assignment

Decision: `admin` may be operationally assigned to a Shop.

Reason: the existing system already supports this in several operational paths. V48.19 makes the rule consistent instead of silently stripping `shopId` from admin edits.

### D-02 Inactive Shop

Decision: inactive Shop accepts no new operational work. Historical records remain.

Implemented at the boundaries listed above.

### D-04 Active Order delivery identity

Documented existing behavior:

- Order/session ownership is frozen according to the Order lifecycle;
- active delivery identity fields such as current shop name/address may be refreshed until terminal so warehouse uses current delivery details.

Therefore `buyerSnapshot` is a hybrid contract; callers must not assume every field is immutable simply because the property is named snapshot.

### D-03 Supplement topology

Not silently changed in V48.19.

Recommended next policy remains:

```text
block Shop delivery-group move while a relevant supplement wave/request is active
```

This requires supplement-specific referential work and belongs to the next reliability phase instead of being hidden inside the assignment fix.

---

## 12. Invariants protected by V48.19 tests

1. Seller/admin role vocabulary is single-source.
2. `assigned` != `operational` is preserved.
3. Readiness has CURRENT topology and no historical session roster.
4. CatalogReview/history cannot change `currentAssignment`.
5. Seller/order mismatch is computed from CURRENT assignment.
6. Settings and picking expose the same `currentAssignment` shape.
7. Existing identity cannot be raw-updated through POST /users.
8. Existing User shop changes use migration/unassignment.
9. Soft-removed role change validates intended role.
10. Target Shop is re-read inside canonical migration.
11. Inactive Shop cannot accept new operational writes at covered boundaries.
12. HTTP and Socket block move call one command.
13. PickingTask position reconciliation is owned by the block command.
14. `current` and `readiness` cache keys cannot collide.
15. "Без продавця" never derives from display `sellerName`.
16. Assigned-but-blocked/removed is shown as a separate readiness problem.
17. Seller actions use current assigned users, not historical display rows.
18. Warehouse drag sends optimistic block versions.

---

## 13. What V48.19 deliberately does NOT rewrite

No Mongo schema migration.

No new assignment collection.

No event sourcing.

No change to OrderingSession identity.

No change to old-session/non-blocking policy.

No change to picking ownership/lease semantics.

No change to receipt lifecycle.

No change to supplement ownership/move policy yet.

No removal of compatibility DTO fields yet; they remain presentation-only during rolling migration.

---

## 14. Next architecture phases

### V48.20 — Mutation authority completion

- inventory all remaining domain writes;
- enforce command ownership for topology transitions;
- add command-level post-commit event/cache contract;
- remove remaining transport-owned mutation behavior.

### V48.21 — Operational read models

- move more aggregation/orchestration out of `deliveryGroups.js`;
- explicit `CurrentTopology`, `UpcomingReadiness`, `ActiveSession`, `HistoricalSession` builders;
- reduce generic compatibility fields.

### V48.22 — Referential / projection reliability

- supplement topology transition policy;
- Shop/DeliveryGroup supplement delete guards;
- Product -> ShopProduct durable repair/reconciler;
- legacy cart/current-order separation;
- shared live-order/live-item predicates.

The order is intentional: first establish semantics and authority, then simplify the remaining projections.
