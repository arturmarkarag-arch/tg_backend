# 2026-08-11 — Receipt contract cleanup v34.3

## Decisions fixed as contract

- CORRECTION: multi-seller shops are supported. Seller presence alone is not a conflict; see `operational-session-contract.md`. The earlier one-seller wording was incorrect and has been removed from runtime guards.
- `ReceiptItem.totalQty` remains required and is the single physical quantity received.
- Photo gallery keeps `totalQty + destination + receiptType` and the client stays at 2 photos per row.
- Current receipt destination remains mutually exclusive: `shelf | shops`.
- Mixed `shelf + shops` quantity split is deliberately deferred until the business rule is agreed.
- Confirmed-item edit/quantity semantics were deliberately not redesigned in this change.

## Removed from receipt contract

- pallet/box structure (`structure`, pallets/boxes/items fields);
- `expectedQty`;
- derived `shelfQty` / `transitQty` copies;
- receipt barcode;
- `existingProductId` matching/link flow;
- manual product name input;
- defect evidence photos;
- receipt `notes`;
- `warehousePending` and `PATCH /receipts/:id/items/:itemId/link` resolution path.

Internal/background AI `name + aiDescription` remain permitted. They are generated from the photo and are not manual receipt form fields.

## Integrity fixes

- Receipt PATCH now re-checks `{ _id, status: 'draft' }` inside the same Mongo transaction as `ReceiptItem.save()`.
- Receipt-created warehouse items use `createdProductId`; supplement offers no longer fall back to `existingProductId`.
- Shop-owned receipt products are idempotent by receipt item / created ShopProduct id, not by receipt barcode.

## Legacy warehouse shift cleanup

Removed the retired `/api/warehouse` shift router and User fields:

- `isWarehouseManager`;
- `isOnShift`;
- `shiftZone`;
- old shift-status / confirm-shift / close-shift / remove-from-shift mutations.

The current picking shift board at `/api/picking/shift-board` remains unchanged.

## One seller per shop hardening

- normal seller migration checks that the target shop has no other active seller;
- seller registration/reactivation checks the same slot;
- legacy bulk seller endpoint rejects 2+ sellers;
- shop editor only exposes assignment UI when the shop has no seller;
- historical/corrupted multi-seller data is not silently rewritten and remains a repair/audit concern.

## DB cleanup

Added dependency-free migration:

- dry run: `npm run migrate:receipt-contract-cleanup`
- apply: `npm run migrate:receipt-contract-cleanup:apply`

It unsets retired ReceiptItem fields and retired User shift fields. It explicitly preserves `ReceiptItem.totalQty`, `name`, and `aiDescription`.

## Verification

- all server `.js` files passed `node --check`;
- modified client JS/JSX passed TypeScript parser (`tsc --noResolve`);
- dependency-free static contract assertions passed;
- full Vitest/Vite run was unavailable in the work environment: online registry access returned `EAI_AGAIN`, and offline install was missing cached packages (`ENOTCACHED`).
- the checked-in client `dist/` from the uploaded archive was therefore not rebuilt; deploy/build from `src/` with the normal `npm run build` pipeline.

## Deferred

- mixed `shops + shelf` quantity split;
- “Нові товари → може приїхати НЕ ВСІМ” routing marker;
- any redesign of editing already-confirmed receipt items.
