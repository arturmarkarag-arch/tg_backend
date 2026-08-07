# 2026-08-07 — Closed ordering status center

## Goal
Replace the seller's bare “ordering closed” message with a useful status center that explains the current cycle: seller/shop context, the seller's own order, warehouse picking progress, and the delivery handoff state.

## Server changes
- `GET /api/delivery-groups/ordering-status` now returns `closedDashboard` while the seller's ordering window is closed.
- The payload includes seller, shop/city/address, delivery group, current ordering session, session sequence, planned delivery date, shop box number, catalog-review mark, seller order summary, warehouse task progress, picking timestamps and problem item summaries.
- Seller order summary distinguishes packed, pending, cancelled/out-of-stock, strict-late skipped and short-picked quantities.
- `unknown delivery` is not fabricated: the current data model has no dispatch/driver/ETA/delivered state, so the API exposes only the real warehouse-to-delivery handoff status.
- Dashboard aggregation is best-effort. A failure falls back to the old basic ordering-window response instead of breaking access.

## Client changes
- The closed ordering screen is now a three-part status center:
  1. “Про мене і моє замовлення”
  2. “Складання на складі”
  3. “Доставка”
- Added a compact 3-step summary: order → warehouse → delivery.
- Shows both group picking progress and progress of the seller's own order.
- Shows problem lines such as out-of-stock, skipped late items and short-picks.
- Adds a read-only “Показати всі позиції” list so the seller can still inspect the whole current order after picking starts.
- Shows session/shop box number when warehouse numbering has been frozen.
- `useOrderingStatus` refreshes the closed status every 15 seconds and immediately after `user_order_updated` for the current seller.

## Explicitly not implemented
Actual logistics tracking is not represented by the current database model. To show “vehicle departed”, driver, ETA and “delivered to shop”, a separate delivery lifecycle should be added rather than inferring those states from picking completion.

## Verification
- `node --check routes/deliveryGroups.js` — passed.
- TypeScript `transpileModule` syntax parse for changed client JSX/JS files — passed.
