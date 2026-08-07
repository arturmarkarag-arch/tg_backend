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

## Deliberately not hard-enforced yet

`1 shop = 1 seller = 1 active order/session` is the target contract but live data must be
repaired before adding a strict shop/session unique index. Current start-session conflict
protection remains in place.
