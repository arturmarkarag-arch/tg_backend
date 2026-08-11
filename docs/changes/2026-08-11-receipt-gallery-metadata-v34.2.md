# 2026-08-11 — Receipt photo gallery metadata v34.2

- Kept the receipt photo gallery at two columns.
- Added quantity beneath every photo.
- Added destination/current-routing label beneath every photo:
  - regular + `shelf` → `На склад`;
  - regular + `shops` → `На магазини`;
  - `supplement` receipt → `Допродаж + склад`.
- Extended read-only `GET /receipts/items-gallery` with `totalQty`, `destination`, and `receiptType`.
- Receipt context is resolved with one batched lookup; no per-photo N+1 queries.
- No receiving, confirmation, commit, stock, or supplement business logic was changed.
