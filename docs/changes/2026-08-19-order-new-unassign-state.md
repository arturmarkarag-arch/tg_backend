# 2026-08-19 — Order `new_unassign` parked state

Base artifacts:
- `server(20260818-020430).zip`
- `client(20260818-020421).zip`

## Business rule

A seller unassignment must not destroy Order ownership in order to keep the Order out of picking.

While the Order is still mutable:

```text
new | in_progress
  -> seller unassigned
new_unassign
```

`new_unassign` keeps:
- `shopId`
- `buyerSnapshot.shopId`
- `buyerSnapshot.shopName/city/address`
- `buyerSnapshot.deliveryGroupId`
- `orderingSessionId`
- items/history

It is not ACTIVE operational work and therefore does not enter picking, active-order blockers, or the session completion denominator.

When the seller is assigned again while Order ownership is still mutable, the canonical assignment command moves/restamps the Order for the target shop/session and restores:

```text
new_unassign -> new
```

If the original Order ownership is already frozen (ordering closed / picking started), a profile assignment does not implicitly resurrect the parked Order into warehouse work.

## Legacy repair

`services/orderUnassignStateMigration.js` runs on boot before Order index synchronization. It recognizes only the exact pre-change parked representation:
- active status (`new|in_progress`)
- non-empty `orderingSessionId`
- `shopId=null`
- missing/null snapshot shop
- missing/null/empty snapshot delivery group

Such rows are reclassified to `new_unassign`. Ownership is never guessed or reconstructed by the migration.

## Verification

- Order unassign architecture checker: 11/11 PASS
- Server release static: 26/26 PASS
- Recursive server `node --check`: 323/323 PASS
- Client Order status checker: 2/2 PASS
- Client aggregate still has the same 6 inherited source-check failures present in the input artifact; this change added no new client aggregate failure.

Full Vitest/live Mongo gate was not executed because the provided archives do not contain `node_modules`/live TEST credentials.
