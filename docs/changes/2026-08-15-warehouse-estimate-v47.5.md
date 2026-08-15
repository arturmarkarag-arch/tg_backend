# V47.5 — informational warehouse estimate

Added staff-only `GET /api/v1/products/warehouse-stats?ids=...`.

For up to 50 visible warehouse products it returns:
- physical quantity received from `ReceiptItem.totalQty`;
- ordinary seller-order package count from `Order.items[].quantity` (excluding `direct_allocation`);
- supplement package count from `SupplementRequest.quantity`;
- current `Product.quantityPerPackage`;
- ordered units and an estimated remaining unit balance.

The endpoint is read-only. The estimate is intentionally **not** a stock source of truth and never changes Product quantity/status, receipt routing, archive logic, sessions, or picking.

## Package metadata for seller views

Read APIs used by the seller's current order and supplement flow now expose the product's current `quantityPerPackage` so the client can consistently display the stored order quantity as a package multiplier (`×N packages`) plus its informational unit conversion.
