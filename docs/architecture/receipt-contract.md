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
DeliveryGroup -> OrderingSession -> one stable SupplementWave container -> item revision -> Shop request
```

Confirmation and supplement publication are separate operations. Confirm makes a
ReceiptItem eligible; an explicit publish command chooses exactly one currently
eligible DeliveryGroup + exact `OrderingSession` and creates/uses one Wave. One
Wave can contain many items.

Publication eligibility is item-global. A READY ReceiptItem is target-neutral
until the first publication wins the global transaction fence. Active OPEN or
FROZEN work holds that fence. Cancelling either state releases the ReceiptItem to
READY when its supplement route remains enabled; COMPLETED history is terminal.
`supplementPublishRequestedAt` remains compatibility/audit metadata only.

The Wave is the stable `DeliveryGroup + OrderingSession` container. Lifecycle
authority is per item revision: `ready -> open -> frozen -> completed`, with
`cancelled` as an audited correction/termination path. Seller request writes are allowed only for that item's OPEN
current revision; packing starts only after that item is FROZEN. The container status
is a derived summary, not a global seller lock. Lifecycle notifications remain
grouped at container/activity level rather than per-product Telegram spam.

A warehouse Product offered through SupplementWave in Session A stays excluded
from ordinary ordering for all of Session A, including after its supplement work
completed. Later sessions see it through normal warehouse rules. Cancellation of
OPEN or FROZEN removes that exact-session exclusion because the publication was
explicitly stopped. Future/upcoming sessions are never supplement targets.

Legacy `SupplementOffer.waveId=null`, old receipt-level supplement flows and old
legacy batch markers remain compatibility-only; modern publication joins the stable group+session container and uses item revisions, with no destructive history migration.

## 8. Editing and concurrency

A completed Receipt is not globally read-only. Receiving and commercial metadata
corrections remain allowed. For the same item, photo, price, quantity-per-package,
received quantity, comments/name/description are metadata UPDATEs: they preserve the
current supplement revision and Shop requests, and synchronize current OPEN/FROZEN
supplement snapshots. Terminal revision snapshots remain immutable history.

Receipt-derived shared commercial metadata has one write-through authority: edits
from Receipt, warehouse Product or ShopProduct views converge through ReceiptItem and
then propagate to derived Product/ShopProduct/current supplement projections.

Published **route** corrections use the separate canonical compensating
`CorrectReceiptItemRouting` command. It cancels unfinished supplement work only when
the new route no longer contains `supplement`; if supplement remains, requests stay.
Packed/history facts are preserved and completed historical revisions are never
rewritten.

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
