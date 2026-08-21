# 2026-08-21 — Receipt / Supplement lifecycle guard

## Причина

Інцидент 2026-08-20 показав, що confirmed routing correction могла заархівувати
фізичний Product і зняти його з Block. Додатковий аудит виявив, що старий контракт
також змішував technical rollback, Supplement cancellation і physical lifecycle.

## Новий контракт

Див. `docs/architecture/supplement-routing-contract-2026-08-21.md`.

Ключові рішення:

- `Склад`, `Дозамовлення`, `Обов'язковий` — окремі routing concepts;
- mandatory не отримує окремої production state machine;
- supplement-only і mandatory-only створюють receipt-owned ShopProduct та видимі в
  «Товари Магазинів» / «Нові Товари»;
- OPEN Supplement блокує route correction;
- FROZEN дозволяє route correction; видалення supplement анулює всю current revision;
- cancellation анулює також packed-marked requests, packed fields лишаються audit;
- wrong group виправляється cancel + clean revision republish;
- supplement target `ordering_open` заборонений server-side;
- route correction ніколи не Archive;
- warehouse remove через Receipt дозволений тільки до першого shelf/order/picking fact;
- Archive reconciles active supplement demand;
- Product physical commands share one product lifecycle lock;
- receipt-owned ShopProduct не можна видалити напряму;
- Product.receiptItemId має unique partial identity backstop;
- batch preflights all confirmed rows before first write.

## Deployment note

`Product.syncIndexes()` тепер входить у critical startup gate. Якщо в production
лишилися старі дублікати `products.receiptItemId`, сервер має перейти в maintenance
mode замість запуску без гарантії identity. Перед релізом перевірити дублікати та
`ReceiptItem.createdProductId` для кожного конфлікту.

## Verification

Static/source-contract checks оновлені під нові правила. Live Mongo E2E треба запускати
у дозволеному TEST/preprod середовищі з `MONGODB_URI`; архів вихідних файлів не містить
`node_modules` і live env.
