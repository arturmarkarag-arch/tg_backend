# Picking shop product disclosure v15

- Added lazy staff endpoint `GET /api/delivery-groups/:groupId/shops/:shopId/ordered-products`.
- The endpoint is current-session scoped and mirrors the existing shop-status definition of an ordered position: active `new|in_progress` order item, excluding `cancelled` and `skipped`.
- Products are deduplicated by product id and return only the image/name fields needed by the picking board.
- No product documents are added to the normal `/shop-status` response, so the idle picking board stays lightweight.
