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
- a shop becomes a conflict only when CURRENT-session active Orders (`new|in_progress`)
  belong to 2+ distinct buyers;
- that conflict is a HARD gate only before picking starts;
- after picking has started, the same condition is informational only and MUST NOT block
  picking-session closure;
- staff may move a conflicting seller to any other active shop or unassign them. Moving a
  conflict is allowed: if the destination then has active Orders from 2+ buyers, the same
  pre-start gate simply remains blocked there until staff resolves it.

The Order DB unique index intentionally remains `(buyer, shop, session)`. Do NOT replace it
with `(shop, session)`: multiple sellers per shop are a supported business state.
