# Operational Read Models Contract — V48.21

Date: 2026-08-16  
Status: architecture contract for current runtime  
Base: V48.19 Data/State Contract + V48.20 Mutation Authority Contract

## 1. Purpose

V48.19 defined the kinds of truth:

```text
CURRENT
SESSION
HISTORY
DERIVED
DISPLAY
```

V48.20 made writes authoritative:

```text
TRANSPORT -> COMMAND -> TRANSACTION PRIMITIVE -> MONGO -> POST-COMMIT
```

V48.21 applies the same discipline to the **read side**:

```text
Mongo/domain facts
       ↓
Named read model
       ↓
Stable response DTO
       ↓
HTTP transport
       ↓
React query/cache/display
```

The rule is:

> A GET/controller does not assemble business state itself. It selects one named read model and returns its DTO.

A read model may combine facts from multiple collections when that is the explicit purpose of the projection, but it may not mutate domain state, materialise a session, claim locks or perform repair.

---

## 2. Read-model vocabulary

### CURRENT topology projection

Answers present-tense questions only:

```text
Which Shops are active now?
Who is assigned to each Shop now?
Is the assigned person operationally usable now?
```

Canonical implementation:

```text
services/readModels/currentShopTopologyReadModel.js
```

It is structurally forbidden from importing:

```text
Order
OrderingSession
PickingTask
CatalogReview
```

That is stronger than an `if (view === 'readiness')` branch inside a large route: historical/session data is not even in the module's dependency graph.

### CURRENT SESSION projection

Answers:

```text
what belongs to the current OrderingSession?
which current Orders belong to each Shop?
which products are counted as ordered?
which people participated/displayed in this session?
```

Canonical implementation:

```text
services/readModels/currentSessionShopStatusReadModel.js
```

CURRENT assignment remains independent from `sessionParticipants`.

### Seller ordering/session status projection

Canonical implementation:

```text
services/readModels/sellerOrderingStatusReadModel.js
```

It may read:

```text
CURRENT Shop/DeliveryGroup
current OrderingSession identity
current seller Orders
PickingTask progress
CatalogReview history for that session
```

but it may only use:

```text
findCurrentSessionId()
```

never:

```text
getOrCreateSessionId()
```

### Delivery-group catalogue projection

Canonical implementation:

```text
services/readModels/deliveryGroupCatalogReadModel.js
```

The group selector does not derive session phase itself. It delegates to:

```text
getCurrentGroupPresentation()
```

from `sessionPresentation`.

### Lazy shop product disclosure

Canonical implementation:

```text
services/readModels/currentSessionShopProductsReadModel.js
```

It is intentionally separate from the normal shop-status payload so product documents/photos are only loaded after the user expands a Shop.

### Admin session summaries

Canonical implementation:

```text
services/readModels/deliveryGroupSessionSummaryReadModel.js
```

Current-vs-stale is determined by comparing each Order's `orderingSessionId` with `findCurrentSessionId()`.

---

## 3. Controller boundary

`routes/deliveryGroups.js` is no longer the read-model implementation.

The operational GET routes now delegate:

```text
GET /ordering-status
  -> buildSellerOrderingStatusReadModel()

GET /summary
  -> buildDeliveryGroupSummaryReadModel()

GET /:groupId/shop-status
  -> buildDeliveryGroupShopStatusReadModel()

GET /:groupId/shops/:shopId/ordered-products
  -> buildCurrentSessionShopProductsReadModel()

GET /session-summaries
  -> buildDeliveryGroupSessionSummariesReadModel()

GET /
  -> buildDeliveryGroupListReadModel()
```

The route remains responsible for:

- authentication/role middleware;
- HTTP params/query extraction;
- response delivery;
- explicit write endpoints which belong to the command side.

It is not responsible for joining Orders/Users/CatalogReview into a display state.

---

## 4. Read-only invariant

Files under `services/readModels/` are forbidden from using domain-write/session-materialisation primitives:

```text
findOneAndUpdate
updateOne
updateMany
deleteOne
deleteMany
create
save
startSession
withTransaction
getOrCreateSessionId
```

Caching a read result is not a domain mutation. Mongo domain documents remain unchanged.

This invariant is enforced by:

```text
tests/operationalReadModelsV4821.contract.test.js
scripts/checkOperationalReadModelsV48_21.js
```

and the V48.21 checker is part of the ordinary release static gate.

---

## 5. Readiness isolation

Preparation for an upcoming session uses:

```text
view=readiness
```

The facade routes this to:

```text
currentShopTopologyReadModel
```

The returned response deliberately contains:

```text
currentSessionId: null
staleOrderCount: 0
staleOrders: []
```

and each Shop is built only from live Shop/User assignment.

Therefore a previous session cannot influence:

```text
hasAssigned
hasOperationalUser
assignedCount
"Без продавця"
```

through Order/CatalogReview/display history.

---

## 6. Current session and historical display

The current session projection has two distinct lists:

```text
currentAssignedUsers
sessionParticipants
```

They are passed separately to `buildCurrentSessionShopProjection()`:

```text
assignedUsers: currentAssignedUsers
sessionParticipants: sessionParticipants
```

`CatalogReview.shopId` may determine where a historical participant row is displayed, but does not rewrite CURRENT assignment.

No current `OrderingSession` means no current-session `CatalogReview` roster:

```text
currentSessionId ? CatalogReview.find(...) : []
```

This prevents null/legacy history from leaking into an empty current-cycle display.

---

## 7. Canonical Order -> Shop identity inside read models

Some historical/current Order paths contain:

```text
Order.shopId
```

while older/direct paths may only have:

```text
Order.buyerSnapshot.shopId
```

V48.21 uses one resolver inside the current-session Shop projection:

```text
resolveOrderShopId(order)
  = order.shopId || order.buyerSnapshot.shopId
```

The same resolver is used for:

- grouping Orders under Shops;
- building the `orderedBuyerIds` set;
- `hasOrder`/seller-order mismatch calculations.

This closes the previous read inconsistency where a snapshot-only Order could be counted in a Shop's Orders but its buyer could still appear as `hasOrder=false`.

This is a read-model consistency fix; Order ownership/storage is unchanged.

---

## 8. Compatibility fields

V48.21 does not intentionally change current frontend DTO names.

Compatibility/display fields remain, including:

```text
sellers
sellerName
sellerCount
hasConflict
hasMultipleSellers
hasSellerOrderMismatch
staleOrderCount
staleOrders
presentationMode
```

Their meaning is constrained by V48.19:

- business assignment decisions use `currentAssignment`;
- `sellers`/`sellerName` are presentation compatibility fields;
- `presentationMode` is server-authoritative;
- `hasRelocatedOrders` remains diagnostic compatibility, not phase authority.

---

## 9. Explicit non-goals

V48.21 does not resolve the deferred V48.20/V48.22 contracts:

- F-09 supplement ownership when Shop changes DeliveryGroup;
- F-10 Shop/DeliveryGroup deletion with supplement references;
- F-11 durable Product -> ShopProduct convergence;
- F-12 removal of legacy `cartState` from current-session projection;
- F-15 global consolidation of active-Order/live-item predicates.

The local `liveItem()` used by current Shop status and lazy product disclosure keeps those two views internally aligned, but V48.21 does not claim global F-15 closure.

---

## 10. Verification contract

Required before release:

```bash
npm run test:read-models:v48.21
npm run test:data-state:v48.19
npm run test:mutation-authority:v48.20
npm run test:picking:authority
npm run test:picking:readiness
npm run test:release
npm run test:release:static
```

Then the guarded live gate may be run in the normal TEST environment.

No live/TEST/PROD database operation is part of the V48.21 implementation itself.
