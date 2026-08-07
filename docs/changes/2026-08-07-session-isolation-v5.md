# 2026-08-07 — strict session isolation v5

Base: uploaded `server(20260807-152158).zip`, plus the agreed forward-picking, OOS and
session-closure changes reconstructed on top of it.

## Goal

Last week's unfinished Order/PickingTask/OrderingSession is visible, but can NEVER reserve a
slot or block the current cycle.

## Main changes

- PickingTask active unique key is now `productId + deliveryGroupId + orderingSessionId`.
- taskBuilder reads/writes and Redis lock are group+session scoped; it cannot retag an old task.
- late-order reconcile and active-task reconcile are session scoped.
- forward-only picking cursor; another worker ahead is a hard route barrier -> choose new block.
- no wrap-around.
- picking progress is server-authoritative; localStorage progress restore removed.
- complete/OOS waits for the last progress write before finalisation.
- canonical OOS recovery uses `completionReason:'out_of_stock'`, never `items.packed` as cause.
- OOS crash recovery is scoped to the current session so historical OOS cannot re-archive new stock.
- central session closure audit: only current-session blockers; old tasks/orders are warnings.
- archiveProduct re-evaluates only each affected session itself after commit.
- group stale cleanup always excludes the current session.
- shift board shows historical orphan tasks explicitly as `НЕ блокує`.
- read-only `scripts/auditOperationalContracts.js` added for shop/seller/order/task invariants.

## Seller / shop / Order contract

Multiple sellers per shop are supported. One seller has at most one active Order for
`buyer + shop + orderingSession`; that Order contains many product positions. A shop is a
conflict only when current-session active Orders belong to 2+ distinct buyers. That conflict
blocks **picking start only** and is resolved by moving or unassigning a seller. Do not add a
strict `(shop, session)` unique index.
