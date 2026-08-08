# 2026-08-08 — MASS live E2E + Block index safety

## Навіщо

14 live E2E сценаріїв перевіряли окремі edge-cases, але не доводили роботу великої змішаної сесії з десятками одночасних writers/readers.

## Зміни

- Додано `scripts/liveOrderPickingMassE2E.js`.
- Default profile: 100 ordering sellers, 120 shops, 240 products, 12 blocks, 12 concurrent warehouse workers.
- Додано race checks: same-task claim, progress-vs-complete, OOS-vs-complete.
- В одному run змішані conflict gate, stale/orphan previous-session debris, late Orders, OOS, short-pick, hidden item, session/group mismatch, closure repair.
- Додано p50/p95/p99/max API latency report.
- LIVE E2E/cleanup мають double DB-host guard; default allowed cluster suffix: `epfky0s.mongodb.net`.
- npm E2E commands preload `../dev-use-test-db.js`.
- `Block.productIds` critical unique index змінено з `sparse` на partial (`productIds.0 exists`), щоб кілька порожніх Blocks не давали E11000.
- `Block` додано в startup `syncCritical`.
- Cleanup manifest підтримує кілька Block IDs і MASS marker/users.

## Acceptance

1. `npm run test:live:e2e` → 14/14 functional scenarios.
2. `npm run test:live:e2e:mass` → 0 failed assertions.
3. Cleanup → 0 leftovers.
4. На test DB існує `one_product_per_nonempty_block`, старого `productIds_1 UNIQUE sparse` немає.
