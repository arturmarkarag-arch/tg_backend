# Seller catalogue ordinary-order rollback

The global vector route introduced in V48.1 has been retired from the seller catalogue.

## Runtime behavior

`GET /api/v1/products/catalog` keeps its current API and business eligibility rules,
but MongoDB now performs the stable ordinary ordering and pagination directly:

1. active and ordinary-order-enabled Products only;
2. current-session SupplementWave products excluded;
3. seller-cycle cutoff applied;
4. real Block membership required;
5. `orderNumber ASC`, `createdAt DESC`, `_id ASC`;
6. `$skip` and `$limit` applied in MongoDB.

Pagination inputs are normalized to bounded integers before reaching MongoDB.
Current-session lookup errors fail closed instead of silently disabling the
SupplementWave exclusion.

`GET /api/v1/products/catalog/:id/position` uses the same eligibility pipeline and
counts rows that sort before the target. It no longer builds or scans a global ID list.

## Removed hot-path work

- no ProductVector read for catalogue paging;
- no cosine/sketch distance matrix;
- no greedy route or 2-opt passes;
- no `seller-visual:*` Redis lock;
- no daily/group visual-order cache.

ProductVector and embedding generation remain available for actual visual/photo search.
The client keeps the dedicated catalogue URLs, paging, deep links and restore behavior.
