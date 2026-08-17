# Receipt contract — current source of truth (V47.16)

## Purpose

`Receipt` is the physical receiving document. `ReceiptItem` also carries the later
product-preparation/publication state, but that later state is not part of the
receipt UI itself.

## 1. Receiving document

Current `regular` receipt UI records only:

- photo;
- `totalQty >= 1`.

No price, package quantity or routing is collected by the receiving modal.
For `routingVersion >= 1`, `totalQty` is reference receiving metadata, never a
formula input for automatic warehouse leftovers or routing.

## 2. Receipt completion is independent from publication

For current regular receipts (all rows `routingVersion >= 1`) the receipt may be
completed once it contains valid receiving rows. Current receipt commit:

- marks `Receipt.status='completed'`;
- stamps `completedAt`;
- does not require item confirmation;
- does not require price/package/route;
- does not create a product merely because the receiving document was closed.

Legacy rows/whole-receipt supplement documents keep the previous commit contract.

## 3. Commercial preparation under the full-photo feed

`Накладні → Фото → Редагувати` expands the preparation controls inline under the
selected photo. Stage 2 requires:

- `price > 0`;
- `qtyPerPackage >= 1`.

The server enforces this with `assertItemReadyForRouting`. An annotated customer
photo may be regenerated from `originalPhotoUrl`, but image rendering itself is
not a business gate.

## 4. Routing

After Stage 2, current routing is stored in `ReceiptItem.routing`:

```text
warehouse
mandatory
supplement
mayNotReachAllShops
supplementDeliveryGroupId
```

Allowed: warehouse; mandatory; mandatory+warehouse; supplement;
supplement+warehouse. Mandatory+supplement is forbidden.

Route changes are atomic and only match `ReceiptItem.status='draft'`. Price and
package predicates are repeated in the atomic update, closing readiness races.

## 5. Publication boundary

`POST /receipts/:id/items/:itemId/confirm` is the publication boundary. It can run
before or after the parent Receipt is completed.

Before confirm the item must have:

- photo;
- `totalQty >= 1`;
- `price > 0`;
- `qtyPerPackage >= 1`;
- valid route;
- supplement group when needed.

Confirm creates/synchronizes the correct `Product` / `ShopProduct` artifacts and
then marks the item confirmed. Unconfirm is the guarded rollback path. The single post-confirm exception is additive `POST /receipts/:id/items/:itemId/add-warehouse-remainder`: it only flips `routing.warehouse` false→true after an already-confirmed mandatory/supplement route and never recreates primary-route artifacts or notifications.

## 6. Derived documents

- warehouse → `Product` + linked `ShopProduct` mirror;
- mandatory-only → standalone shop-owned `ShopProduct`;
- mandatory+warehouse → one `Product` + mirror;
- supplement-only → no warehouse `Product` is required; Wave child may have `productId=null`;
- supplement+warehouse → real `Product` plus a session-scoped supplement child; the Product remains eligible for future ordinary cycles.

For new routing rows, warehouse `Product.quantity` starts at `0`; received quantity
is not treated as an exact remaining stock counter.

## 7. Supplement behavior

Canonical supplement ownership is:

```text
DeliveryGroup -> OrderingSession -> SupplementWave -> Wave item -> Shop request
```

Confirmation and supplement publication are separate operations. Confirm makes a
ReceiptItem eligible; an explicit publish command chooses exactly one currently
eligible DeliveryGroup + exact `OrderingSession` and creates/uses one Wave. One
Wave can contain many items.

Publication eligibility is exact-session aware. The same ReceiptItem may be
published independently into multiple simultaneously-current eligible target
sessions. `supplementPublishRequestedAt` is compatibility/audit metadata only and
is not lifecycle or target authority.

Wave lifecycle is `open -> frozen -> completed` with `cancelled` terminal path.
Seller request writes are allowed while open and rejected after freeze. Warehouse
packing starts only after freeze. New Wave lifecycle notifications are Wave-level,
not per product.

A warehouse Product offered through SupplementWave in Session A is excluded from
ordinary ordering in Session A only; later sessions see it through normal warehouse
rules. Future/upcoming sessions are never supplement targets.

Legacy `SupplementOffer.waveId=null`, old receipt-level supplement flows and old
batch markers remain compatibility-only and require no destructive migration.

## 8. Editing and concurrency

A completed Receipt is not globally read-only. Receiving corrections and Stage 2
updates remain allowed under ownership/in-use guards. Published route corrections use the canonical compensating `CorrectReceiptItemRouting` command. It cancels unfinished wrong-path work, preserves packed/history facts and applies canonical artifacts for the new route. Completed historical Waves are never rewritten.

## 9. Full-photo UI projection

`GET /receipts/items-gallery` remains a lightweight feed for the two-column photo
view. It includes photo, received quantity, receipt id and normalized route inputs.
The full item/receipt data needed for editing is fetched only when `Редагувати` is
expanded, using the existing detail/items queries.

This keeps the gallery light while the inline preparation panel has authoritative
state from TanStack Query.

## 10. Seller-session stability

Normal seller catalogue membership remains frozen by the current ordering-cycle
cutoff. Receiving/preparing a product does not inject it into an already-open normal
seller session. Supplement has its separate group-scoped rules.
