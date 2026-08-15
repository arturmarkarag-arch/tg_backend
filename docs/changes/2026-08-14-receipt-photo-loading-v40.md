# 2026-08-14 — Receipt photo loading V40

`GET /v1/receipts/items-gallery` now includes `originalPhotoUrl` in its minimal projection so the client photo gallery can display the clean original and fall back safely for legacy rows. No receipt business logic was changed.
