# Operational session contract

## Purpose

Warehouse/order cycles are isolated by `OrderingSession`. Historical damage must remain
visible and repairable, but it must never reserve operational resources or block a later
week's work.

## Canonical identities

- Delivery membership: `User.shopId -> Shop.deliveryGroupId -> DeliveryGroup`.
- Ordering session: unique `(groupId, openDate)` in `OrderingSession`.
- Active picking task: unique `(productId, deliveryGroupId, orderingSessionId)` while
  `status in [pending, locked]`.
- Every operational PickingTask query/auto-advance is scoped by `orderingSessionId`.

## Blocking rule

Only defects that belong to the CURRENT `orderingSessionId` may block that session:

- active current-session PickingTasks;
- current-session coverage gaps;
- current-session unterminated Order items;
- session-owned task/order with a delivery-group mismatch (corruption guard);

Historical/foreign state is visibility-only:

- active PickingTask with another/null `orderingSessionId`;
- active Order with another/null `orderingSessionId`;
- old OrderingSession left confirmed/in_progress.

Those are `warnings`, never `blockers` for a new/current session.

## No cross-session resource reservation

An old pending/locked task may coexist with a new task for the same product and delivery
group because active uniqueness includes `orderingSessionId`. The taskBuilder lock is also
`group + session` scoped.

A historical repair may re-evaluate and eventually close the historical session itself,
but it never participates in `maybeCompleteSession()` or coverage of another session.

## Cleanup rule

`POST /delivery-groups/:id/close-ordering-session` is historical cleanup only. It always
excludes the current session. Current Orders are terminalised only by their own order /
picking / coverage lifecycle, never by a group-wide stale cleanup.

## Physical picking route

Auto-advance is forward-only using `(blockId, positionIndex)` inside one session. No
wrap-around. A task locked by another worker is a physical barrier; the worker is returned
to explicit block selection instead of jumping over the colleague.

## Progress ownership

Picking checkbox state is server-authoritative. There is no localStorage restore of packed
shops. Before final complete/OOS, the client waits until the newest progress write has been
acknowledged by the server.

## Shop -> seller -> order contract

Multiple sellers MAY be assigned to one shop. Seller presence alone is not a conflict.

- one seller has at most one active Order for `(buyer, shop, orderingSession)`;
- that Order contains N product positions;
- a shop may therefore have multiple active seller-authored Orders in the same session;
- a shop becomes a conflict only when CURRENT-session active Orders (`new|in_progress`)
  belong to 2+ distinct buyers;
- that conflict is a HARD gate only before picking starts;
- after picking has started, the same condition is informational only and MUST NOT block
  picking-session closure;
- staff may explicitly resolve a current-session conflict by moving/parking the affected
  Order through the dedicated conflict-repair flow. Moving a conflict is allowed: if the
  destination then has active Orders from 2+ buyers, the same pre-start gate remains blocked
  there until staff resolves it.

The Order DB unique index intentionally remains `(buyer, shop, session)`. Do NOT replace it
with `(shop, session)`: multiple sellers and multiple seller-authored Orders per shop are a
supported business state.

### Order ownership after ordering closes

`buyerTelegramId` is the immutable AUTHOR/provenance of the Order. The shop is the operational
OWNER/destination represented by `shopId` + `buyerSnapshot`; `orderingSessionId` fixes the cycle.

While the ordering window is open and `pickingStatus === 'pending'`, an ordinary seller shop
change may carry that seller's active Order with them. Once the session's `closeAt` is reached
(or picking has already left `pending`), ordinary seller reassignment/unassignment MUST NOT
rewrite any of these Order ownership fields:

- `buyerTelegramId`;
- `shopId`;
- `buyerSnapshot.shopId/shopName/shopCity/shopAddress/deliveryGroupId`;
- `orderingSessionId`.

After that freeze, `User.shopId` may change independently. The seller remains the historical
author, while the closed-session Order stays with the shop/session where it was placed.

### Seller assignment Order resolution

Ordinary `User -> Shop` assignment MUST discover the seller's mutable Order from actual
seller/order ownership state, not from an assumed session bucket. In particular, CURRENT or
NEXT is **never** a source lookup rule. A mutable Order may have been routed into the immediate
next cycle because the destination CURRENT session had already entered picking; it still remains
the seller's transferable Order until ownership freezes.

Canonical rules:

- classify all non-terminal seller Orders through the shared ownership lifecycle;
- frozen/history Orders are visibility-only and never block a new assignment or a new week;
- at most ONE non-frozen/transferable Order may exist for the seller's CURRENT assignment;
- if one transferable Order exists, its Shop must match `User.shopId` before the mutation;
- `new_unassign` is the only canonical parked mutable shape while `User.shopId=null`;
- multiple transferable Orders, Shop/snapshot disagreement, or a mutable Order on a different
  CURRENT Shop are invariant violations: fail closed instead of guessing;
- after an assignment write, the same invariant is checked again inside the transaction.

Only after the source Order has been resolved does destination routing answer a separate
question: which session of the target Shop can accept it. The CURRENT session is used only
while the target ordering window is open and `pickingStatus === 'pending'`. Once ordering
closes or picking starts, assignment routes the mutable Order to NEXT. This prevents an
ordinary profile move from creating an immediately-frozen Order in a closed target cycle.
The session chosen for the destination must never determine whether the source Order is
visible to migration.

Explicit staff ownership repair is a separate intent from ordinary profile assignment. It may
repair a closed, pre-picking Order when the operator deliberately selects it, but it must share
the same seller-assignment lock, destination routing, transactional post-invariant and durable
audit. Physical picking ownership is never overridden.
