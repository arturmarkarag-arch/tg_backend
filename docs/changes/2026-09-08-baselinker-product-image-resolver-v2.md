# BaseLinker product image resolver v2 — 2026-09-08

- Base inventory image lookups now request `include_channels_media: true`, so channel-only Allegro/Amazon/eBay media exposed by BaseLinker can supply the worker thumbnail when the default catalog gallery is empty.
- Existing exact-source rules remain unchanged: no cross-inventory guessing is introduced.
- A product returned by BaseLinker without any usable image is now `no_image` instead of being counted as resolved.
- Persistent image cache rows are versioned with resolver version 2. Older rows are not treated as fresh by the warmer, so pre-v2 empty results are rechecked automatically after deployment; no manual Mongo cleanup is required.
- External shop/warehouse products continue to use the exact storage-aware BaseLinker product-data lookup and existing batching/cache limits.
- Catalog request-budget/network/API failures are no longer converted into `unresolved_exact_source`; they remain uncached and are eligible for the next bounded sync retry.
