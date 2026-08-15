# 2026-08-14 — Receipt routing V37

## Навіщо зміна

Поточна прийомка змішувала дві різні дії: фізичний прийом товару і бізнес-маршрут.
`ReceiptItem.destination` був XOR (`shelf|shops`), а дозамовлення було властивістю
всієї `Receipt.type='supplement'` накладної. Це не могло коректно описати узгоджені
сценарії `Обов'язковий + На склад` та `Дозамовлення + На склад`.

## Поточний V37 контракт

### Прийом товару

Спочатку створюється `ReceiptItem` без маршруту. Обов'язкові дані прийомки:

- фото;
- `totalQty >= 1` — скільки фізично приїхало.

`price`, `qtyPerPackage`, коментар/розмітка фото лишаються редагованими метаданими.

`totalQty` для `routingVersion>=1` є довідковою цифрою прийомки. Вона НЕ є
authoritative warehouse remainder і НЕ запускає формулу `received-distributed-ordered`.
Новий Product, створений з V37 receipt item, стартує з `quantity=0`.

### Маршрут після прийому

`ReceiptItem.routing`:

```js
{
  warehouse: Boolean,
  mandatory: Boolean,
  supplement: Boolean,
  mayNotReachAllShops: Boolean,
  supplementDeliveryGroupId: String | null
}
```

Дозволено:

- `warehouse`;
- `mandatory`;
- `mandatory + warehouse`;
- `supplement`;
- `supplement + warehouse`.

Заборонено:

- `mandatory + supplement`;
- `mayNotReachAllShops` без `mandatory`;
- `mayNotReachAllShops + warehouse` — це суперечливий стан: `warehouse=true`
  означає, що після обов'язкової роздачі товар ще лишився.

Маршрут змінюється окремим `PATCH /receipts/:id/items/:itemId/routing`, тільки поки
позиція `draft`. Запис атомарний (`findOneAndUpdate` + `status:'draft'`), тому
`routing` не може тихо змінитися одночасно з confirm. Кожна зміна пишеться у
`ReceiptItemLog` як `routing_change`.

## Артефакти по сценаріях

### На склад

- створюється `Product`;
- `orderingEnabled=true`;
- створюється/синхронізується linked `ShopProduct` mirror;
- товар видно у `Надходженнях` навіть при `Product.quantity=0`;
- після першого розміщення в блоці фіксується `firstBlockPlacedAt`;
- seller ordinary catalog допускає товар лише з наступного ordering cycle, якщо
  він був фізично поставлений у блок після старту поточного cycle.

### Обов'язковий

- не створюється warehouse Product;
- створюється standalone `ShopProduct` (`linkedProductId:null`, `source:'receive'`);
- для V37 він має `orderingEnabled=false`, тобто не стає товаром, який продавець
  сам вибирає у звичайному каталозі;
- лишається інформаційно доступним у `Нових товарах`;
- `mayNotReachAllShops` задається вручну.

### Обов'язковий + На склад

- створюється один warehouse `Product` + його mirror;
- `mandatoryDistribution=true` зберігає факт обов'язкового сценарію;
- `orderingEnabled=true` для майбутнього normal ordering;
- `mayNotReachAllShops=false` примусово, бо цей сценарій означає, що після
  обов'язкової роздачі товар ще лишився.

### Дозамовлення

- створюється `Product` для фізичного розміщення та supplement picking;
- supplement-only Product має `orderingEnabled=false` і не потрапляє у ordinary
  seller ordering;
- `SupplementOffer` створюється для `routing.supplementDeliveryGroupId`;
- `productId` користувач не вводить — сервер бере `ReceiptItem.createdProductId`.

### Дозамовлення + На склад

- використовується той самий Product;
- `orderingEnabled=true`;
- supplement flow працює окремо;
- normal seller ordering отримує товар лише відповідно до session cutoff.

## Дозамовлення: часові та групові гарантії

Для нового per-item flow дозамовлення можна вибрати/відкрити тільки тоді, коли
ordinary ordering window цільової групи вже закритий. Перевірка виконується:

1. при записі group у routing;
2. перед confirm у completed regular receipt;
3. у commit preflight;
4. повторно на фактичній межі `SupplementOffer.create`, щоб delayed reconciliation
   не відкрив стару хвилю у наступному тижні.

Freeze тепер scoped як `receiptId + deliveryGroupId`, тому одна regular receipt може
мати supplement items різних груп без взаємного закриття.

Додатковий safety-net: якщо склад забув вручну freeze старої хвилі, scheduler при
старті наступного ordinary ordering window цієї групи переводить її `open -> frozen`.
Seller API має той самий runtime-gate, тому продавець не може додати/змінити заявку
навіть у проміжку до хвилинного scheduler tick. Існуючі заявки не видаляються і
можуть бути допаковані складом.

## Стабільність ordinary seller session

У `Product` додано `firstBlockPlacedAt`. Перше фізичне розміщення у блоці фіксує
дату один раз. Seller `/api/v1/products`, deep-link position і server order writes
перевіряють current ordering-cycle open time.

Результат:

- товар може фізично з'явитися у складі/блоці під час активної сесії;
- у поточному seller ordering він не з'явиться;
- у наступному cycle автоматично стане eligible;
- ручний POST з відомим `productId` теж не обходить gate.

Legacy products без `firstBlockPlacedAt` використовують fallback `shelvedAt/createdAt`,
щоб rollout не сховав старий каталог.

## Критичний zero-quantity fix

`GET /blocks/incoming/products` раніше показував receipt goods тільки при
`quantity>0`. Це суперечило новій моделі, де V37 Product навмисно має quantity=0.
Тепер `source:'receipt'` pending Product лишається у `Надходженнях` незалежно від
quantity, тому його можна фізично поставити у блок.

## Фото-режим накладних

`Накладні ↔ Фото` лишається чистою зміною представлення. `GET /receipts/items-gallery`
повертає лише `_id + photoUrl`, newest first. UI не показує ціну, кількість, маршрут,
назву, статус, дату чи автора.

## Legacy compatibility

Не робилась destructive migration.

Збережено читання/роботу старих:

- `Receipt.type='supplement'`;
- `ReceiptItem.destination='shelf|shops'`;
- старої delta-синхронізації `totalQty -> Product.quantity` для `routingVersion<1`;
- legacy whole-receipt supplement target/freeze fallback.

Новий UI whole-supplement Receipt більше не створює.

## Прибране/очищене

- current UI type picker накладної видалено;
- routing прибрано з `AddReceiptItemModal`;
- старі коментарі про XOR/destination як current source of truth прибрано з
  актуальної документації;
- історичні `docs/changes/*` не переписувались.

## Перевірки

Пройдено:

- `node --check` змінених server JS/test files;
- TypeScript parser для змінених client JS/JSX/test files;
- zero-dependency `npm run test:v37:routing` / `node scripts/checkReceiptRoutingV37.js`;
- package.json JSON parse;
- archive integrity після фінального пакування.

Повний `vitest/build` у цьому робочому середовищі не запускався: `npm ci` не зміг
завершити встановлення залежностей у доступному контейнері. Частковий `node_modules`
перед архівацією видаляється і не входить у результат.

## Свідомі обмеження

- точний authoritative leftover/reservation stock math поки не вводиться — це
  свідоме бізнес-рішення;
- обов'язковий розподіл конкретним магазинам залишається ручною дією складу;
- `mayNotReachAllShops` — ручна ознака, не розрахунок з `totalQty`;
- legacy whole-supplement endpoints лишаються для старих даних/кешованих клієнтів.
