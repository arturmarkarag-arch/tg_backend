# V47.9 — Receipt photo date filters

`GET /receipts/items-gallery` now accepts `dateFrom` / `dateTo` and filters gallery items by the parent Receipt `createdAt`, using the same inclusive end-of-day semantics as `GET /receipts`.

No receipt routing or lifecycle behavior changed.
