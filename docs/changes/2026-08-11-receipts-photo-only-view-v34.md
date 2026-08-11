# V34 — Receipts photo-only view

- Existing Receipt/ReceiptItem business logic is unchanged.
- Added read-only `GET /receipts/items-gallery` for newest ReceiptItem photos.
- Receipts page now reuses the Archive-style persisted view toggle.
- `compact` keeps the existing receipts UI unchanged.
- `full` shows only newest product photos, full-width, with pagination.
- No price, quantity, destination, receipt number, status, name, date, or other item metadata is rendered in photo mode.
