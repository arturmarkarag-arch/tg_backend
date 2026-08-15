# V38 — receipt readiness + full-photo context

## Restored publication gate

Draft receiving remains lightweight: photo + received quantity are enough to SAVE a row.
Before CONFIRM/PUBLISH, however, the row must also have:

- price > 0;
- qtyPerPackage >= 1;
- valid routing (and supplement group when applicable).

The server enforces this in `assertItemReadyToConfirm()`, re-checks every row during receipt commit, and refuses edits that would make an already-confirmed row incomplete.

## Full-photo receipt view

The `Фото` view now shows only the requested context under each full image:

- received quantity;
- normalized destination/routing label;
- `Редагувати` button.

The edit button opens the source receipt and automatically opens that exact `ReceiptItem` in the existing edit modal. The gallery endpoint stays read-only and does not expose price, status or author.

## Small regression cleanup

Removed an accidental duplicate `deleteReceiptItem()` call in `ReceiptDetailPage`.
