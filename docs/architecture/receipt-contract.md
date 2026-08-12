# Receipt contract

## Purpose

`Receipt` / `ReceiptItem` describe the physical acceptance of goods. The receipt is an
acceptance record, not a product-matching form and not a pallet/box calculator.

## Canonical ReceiptItem input

The receipt-facing fields are:

- `photoUrl` / `originalPhotoUrl` + `photoMeta` (including the photo comment);
- `totalQty` — the total physical quantity received, required and `>= 1`;
- `destination` — current routing marker: exactly `shelf` OR `shops`;
- `price`;
- `qtyPerPackage`;
- current shop-routing metadata (`deliveryGroupIds`, `qtyPerShop`) where that workflow uses it.

`totalQty` is the only received-quantity field. There is no pallet/box structure and no
derived warehouse/transit quantity copy.

## Deliberately absent from the receipt form/model

The receipt flow does NOT accept or persist receipt-specific versions of:

- pallet / box structure or expected quantity;
- separate shelf/transit quantities;
- barcode;
- a link to an existing Product;
- a manually typed product name;
- defect-photo collection;
- free-form receipt notes.

Product identity (`name`) and `aiDescription` may be generated internally from the photo in
the background. They are implementation metadata for the Product/ShopProduct created from
the receipt item and are not manual receipt fields.

## Product creation

A warehouse-routed (`destination='shelf'`) receipt item creates/owns its warehouse
`Product` through `createdProductId`. The receipt flow no longer has an
`existingProductId` matching/linking path.

A shops-routed (`destination='shops'`) item does not create warehouse stock; it creates a
shop-owned `ShopProduct`, anchored by `receiptItemId` / `createdShopProductId`.

## Destination

The current contract is intentionally mutually exclusive: `shelf | shops`.

A future split such as `70 -> shops + 30 -> shelf` is NOT encoded yet. Do not simulate it
with two booleans or duplicate `totalQty`; that requires a separate business decision and
quantity-allocation contract.

For `Receipt.type='supplement'`, every item is `destination='shelf'`.

## Item mutation / concurrency

A completed receipt is NOT read-only. Items may be edited, added and deleted at any time;
see `docs/receipt/readme.md` §5 for the business rules.

The gate is no longer the receipt status but the state of what the item created:

- edits always propagate to the derived documents (`services/receiptSync.js`) inside the
  SAME transaction as the item write — the receipt can never diverge from the warehouse;
- `totalQty` is applied as a DELTA to `Product.quantity`, never as an overwrite;
- deleting an item, unconfirming it, or switching its destination first calls
  `describeItemUsage`; anything already in a block / order / picking task / accepted
  supplement request rejects with `receipt_item_in_use`. Receipt editing never archives a
  product and never cancels order items.

PATCH re-reads the item inside its own transaction so concurrent edits serialise on the
document instead of racing on a stale quantity.

## Photo gallery

`GET /receipts/items-gallery` is read-only and intentionally exposes:

- photo;
- `totalQty`;
- `destination`;
- `receiptType`.

The gallery's `totalQty` contract remains canonical.

## Deferred decisions

Not part of this contract yet:

- simultaneous `shops + shelf` allocation;
- final semantics/UI for distributing one `totalQty` between those destinations;
- deleting a completed receipt as a whole (only an empty draft can be deleted);
- a correction/reversal document ("сторно") as an alternative to editing the original.
