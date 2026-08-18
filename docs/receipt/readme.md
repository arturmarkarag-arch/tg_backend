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
Supplement target більше не належить routing-позиції: група та exact `OrderingSession` обираються при публікації `SupplementWave`. Legacy `supplementDeliveryGroupId` читається лише compatibility-path.

## 5. Публікація товару

Після ціни/упаковки та валідного маршруту власник позиції або адміністратор
підтверджує товар. `POST /receipts/:id/items/:itemId/confirm` публікує похідні
артефакти маршруту, але **не відкриває SupplementWave автоматично**.

- `На склад` → warehouse `Product` + linked `ShopProduct` mirror.
- `Обов'язковий` без складу → standalone shop-owned `ShopProduct`.
- `Обов'язковий + На склад` → один warehouse `Product` + mirror.
- `Дозамовлення` без складу → confirmed ReceiptItem готовий до supplement publication; fake warehouse `Product` не створюється.
- `Дозамовлення + На склад` → реальний warehouse `Product` + можливість окремої supplement publication для поточної delivery session.

## 6. Дозамовлення

Канонічний lifecycle належить `SupplementWave`, а не `Receipt`, одному
`SupplementOffer` чи полю `supplementPublishRequestedAt`.

```text
confirmed ReceiptItem(s)
-> staff chooses one eligible DeliveryGroup + exact OrderingSession
-> publish
-> one SupplementWave with many child items
-> OPEN
-> FROZEN / Передати в роботу
-> warehouse packing
-> COMPLETED
```

Один confirmed ReceiptItem може бути незалежно опублікований у кілька **одночасно
поточних і дозволених** delivery cycles. Publication eligibility визначається
наявністю Wave child для exact `orderingSessionId`, а не одноразовим прапорцем
ReceiptItem. `supplementPublishRequestedAt` залишається compatibility/audit marker
«хоч раз публікувався» і не споживає item для інших поточних target sessions.

Future/upcoming session не є supplement-target: якщо item має `warehouse=true`,
наступна група повинна отримати товар через звичайний каталог своєї session.

Поки Wave `OPEN`, продавці можуть змінювати заявки. `FROZEN` є серверною межею:
після неї seller writes заборонені, і лише тоді починається packing.

V48.S3 stable group+session container не є «пачкою товарів»: кожна нова або повторно запущена supplement-позиція додається до одного exact `DeliveryGroup + OrderingSession` container, а чистий повтор забезпечує item `revision`, не нова видима Wave.

Legacy `supplementBatchVersion=0/1`, старий `Receipt.type='supplement'` та
`SupplementOffer.waveId=null` підтримуються compatibility-path без destructive
міграції.

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
