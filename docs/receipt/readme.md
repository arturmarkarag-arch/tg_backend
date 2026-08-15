# Накладні — актуальна логіка V47.16

> Канонічний технічний контракт: `docs/architecture/receipt-contract.md`.

## 1. Накладна = тільки фізична прийомка

Поточний UI створює `regular` накладні. У самій накладній позиція фіксує тільки:

- фото — обов'язково;
- кількість, що реально приїхала (`totalQty >= 1`) — обов'язково.

Ціна, кількість в упаковці, маршрут і новий коментар не належать UI накладної.
Історичні значення в старих `ReceiptItem` не видаляються.

Для current `routingVersion >= 1` `totalQty` є довідковою цифрою прийомки і не
розраховує автоматичний складський залишок.

## 2. Завершення накладної не публікує товар

Для current regular receipt, де всі позиції мають `routingVersion >= 1`,
`POST /receipts/:id/commit` завершує саме акт прийомки після наявності позицій з
фото + `totalQty`.

Воно НЕ вимагає:

- `price`;
- `qtyPerPackage`;
- route;
- `ReceiptItem.status='confirmed'`.

І саме по собі не створює новий `Product`/`ShopProduct`.

Legacy receipts з `routingVersion=0` та старі whole-receipt supplement документи
залишаються на старому commit-контракті для сумісності.

## 3. Підготовка виконується у режимі «Фото»

У `Накладні → Фото` кнопка `Редагувати` розгортає під конкретною фотографією
підготовку цього `ReceiptItem`.

Спочатку обов'язково:

- `price > 0`;
- `qtyPerPackage >= 1`.

Це Stage 2. Серверний `assertItemReadyForRouting` не дозволяє перейти до routing,
поки ці поля не готові.

Якщо є чистий `originalPhotoUrl`, підготовка може перебудувати customer-facing
фото з підписами ціни/упаковки. Для legacy фото без чистого оригіналу дані все
одно зберігаються.

## 4. Потім маршрут

Після Stage 2 доступні:

```text
На склад
Обов'язковий
Дозамовлення
```

Дозволені комбінації:

```text
На склад
Обов'язковий
Обов'язковий + На склад
Дозамовлення
Дозамовлення + На склад
```

`Обов'язковий + Дозамовлення` заборонено.

`Може приїхати не всім` — ручний прапорець тільки для mandatory без warehouse.
Supplement потребує `supplementDeliveryGroupId`.

## 5. Публікація товару

Після ціни/упаковки та валідного маршруту власник позиції або адміністратор
підтверджує товар. Саме `POST /receipts/:id/items/:itemId/confirm` є межею
публікації похідного товару.

Він може працювати і після того, як receiving Receipt уже completed.

- `На склад` → warehouse `Product` + linked `ShopProduct` mirror.
- `Обов'язковий` без складу → standalone shop-owned `ShopProduct`.
- `Обов'язковий + На склад` → один warehouse `Product` + mirror.
- `Дозамовлення` → warehouse `Product` для supplement flow, але без ordinary ordering.
- `Дозамовлення + На склад` → той самий `Product` також іде в normal warehouse flow.

## 6. Дозамовлення

У current regular flow supplement належить конкретному `ReceiptItem` і групі.
V47.16 відділяє підтвердження товару від публікації дозамовлення:

```text
підготувати + підтвердити item
-> supplementBatchVersion=1
-> товар лише ГОТОВИЙ ДО ПАЧКИ
-> Telegram ще НЕ надсилається
```

У `Накладні -> Фото` готові items групуються по delivery group. Працівник один
раз натискає `Відкрити N` / `Запланувати N`. Тільки після цього встановлюється
`supplementPublishRequestedAt`. Якщо ordinary ordering уже закритий, усі offers
групи відкриваються разом і notification layer викликається один раз. Якщо
ordinary ordering ще відкритий, пачка чекає його закриття; scheduler спочатку
відкриває всі publish-requested offers, а потім одним проходом повідомляє групу.

Legacy `supplementBatchVersion=0` та `Receipt.type='supplement'` залишаються
сумісними без міграції.

## 6.1. Залишок після вже підтвердженого маршруту

Після фактичної роботи може з'ясуватися, що товар, який спочатку був:

- `Обов'язковий`, або
- `Дозамовлення`,

ще має залишок для звичайного складу. Це НЕ є reroute і не вимагає unconfirm.

Канонічна дія:

```text
POST /receipts/:id/items/:itemId/add-warehouse-remainder
```

Вона дозволена тільки для current `routingVersion >= 1`, confirmed item, де
`routing.warehouse=false` і первинний route = mandatory або supplement.

Ефект тільки additive:

- `routing.warehouse: false -> true`;
- `status` лишається `confirmed`;
- supplement `Offer`/`Request` НЕ видаляються і НЕ створюються повторно;
- Telegram notification НЕ запускається повторно;
- mandatory semantics не перезапускаються;
- для supplement-only існуючий прихований `Product` стає `orderingEnabled=true`;
- для mandatory-only створюється warehouse `Product`, а існуючий standalone
  `ShopProduct` перетворюється в mirror того самого Product БЕЗ дубля картки.

Повторний виклик idempotent: якщо warehouse уже доданий, side effects = 0.

## 7. Редагування

Receiving fields (фото + `totalQty`) залишаються даними накладної. Shared Stage 2
поля (`price`, `qtyPerPackage`, annotated photo metadata) можуть редагуватися в
підготовці під фото.

Confirmed product можна відкотити тільки через guarded unconfirm; якщо товар вже
використовується у blocks/orders/picking/supplement requests, сервер відмовить.

Для `routingVersion>=1` зміна `totalQty` не змінює `Product.quantity`.

## 8. Фото-режим

Фото-режим показує:

- повне фото;
- кількість, що приїхала;
- поточний route badge, якщо маршрут уже вибрано;
- `Редагувати`, що розгортає inline preparation під цим фото.

Саме тут живуть Stage 2 → Stage 3 → confirmation. У ReceiptDetail цього більше немає.
