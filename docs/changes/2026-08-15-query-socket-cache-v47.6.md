# 2026-08-15 — V47.6 Query/Socket reconciliation

- Authenticated `admin`/`warehouse` sockets now join a private `staff` room.
- `catalogue_updated` remains a small public signal (`action`, ids only).
- Rich catalogue cache patches are emitted only to `staff` as `catalogue_cache_patch`.
- Product edits now notify catalogue listeners for shared field changes (name, price, package size, notes, barcode, description, photo), not only photo changes.
- Shop-owned product create/update/delete/describe also emit coherent catalogue signals.
- Rich patch fields are allow-listed by `utils/catalogueSocket.js`; internal warehouse/routing fields are not broadcast.
- Warehouse estimate compatibility check explicitly asserts that missing legacy receiving data produces `null`, not a fake zero/negative balance.
