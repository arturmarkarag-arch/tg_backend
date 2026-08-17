# Дозамовлення — канонічна архітектура V48.S2

## 1. Доменний сенс

Дозамовлення — тимчасовий додатковий канал замовлення товару для **конкретної
поточної доставки**. Воно не відкриває назад ordinary ordering і не визначає
подальшу долю товару.

Довгостроковий маршрут товару належить `ReceiptItem.routing`:

```text
supplement=true, warehouse=false
  -> дозамовлення цієї доставки; warehouse Product не обов'язковий

supplement=true, warehouse=true
  -> дозамовлення цієї доставки + звичайне складське життя товару далі

supplement=false, warehouse=true
  -> тільки звичайний складський потік
```

`mandatory + supplement` для однієї позиції невалідний.

## 2. Власність циклу

```text
DeliveryGroup
  -> OrderingSession
      -> SupplementWave
          -> SupplementOffer (item / compatibility child)
              -> SupplementRequest
```

Для нових даних:

- Wave має рівно одну `deliveryGroupId`;
- Wave має рівно одну `orderingSessionId`;
- Wave може існувати до старту Picking, якщо ordinary cycle вже почався;
- CURRENT Shop/DeliveryGroup topology не переписує ownership вже відкритої Wave;
- completed/historical session не може отримати нову Wave.

Legacy `SupplementOffer.waveId=null` підтримується окремим compatibility path.

## 3. Вибір цілі

Ціль вирішує `services/supplementTargets.js`.

Заборонені евристики:

```text
"зараз ранок"
"група закрилась N хвилин тому"
"напевно наступна група"
```

Доступні стани поточного cycle:

```text
ordering_open       -> так
awaiting_picking    -> так
picking             -> так
upcoming_not_started-> ні
completed           -> ні
```

Працівник явно обирає групу. UI показує точний `OrderingSession`, а publish
повторно перевіряє цей session ID на сервері.


## 3.1. Один item, кілька поточних target sessions

Один confirmed `ReceiptItem` не «споживається» першою публікацією. Якщо серверний
target resolver одночасно повертає кілька різних поточних delivery cycles, staff
може окремо відкрити Wave для кожної з них — завжди одна група за одну publication.

Канонічний fence:

```text
receiptItemId + exact orderingSessionId
```

Тому `supplementPublishRequestedAt` не є eligibility authority; це лише
compatibility/audit marker. Pending/readiness UI показує `readyCount` окремо для
кожного exact target session. Retry тієї самої publication ідемпотентний.

## 4. Wave

Одна публікація багатьох готових позицій в одну групу/сесію створює одну
`SupplementWave`.

```text
OPEN -> FROZEN -> COMPLETED
  \-> CANCELLED
```

### OPEN

Продавець може створити, змінити або скасувати свою заявку магазину.

### FROZEN

`Передати в роботу` — hard server boundary.

Після freeze:

- seller writes заборонені;
- склад може claim/pack item;
- `packed` не є seller lock, бо продавця вже заблокував Wave status.

### COMPLETED

Усі active Wave items завершені.

### CANCELLED

Компенсуюче terminal-завершення. Уже фізично packed товар не повертається з
коробки; незавершені заявки скасовуються.

## 5. Заявка магазину

Одна заявка належить Shop; seller/admin — actor/provenance.

```text
offerId + shopId -> unique
quantity         -> 1..6
```

Кількість — це demand, а не гарантований stock reservation. Поточна версія не
робить fair allocation і не гарантує залишок конкретному магазину.

## 6. Packing

Новий Wave item не можна claim або pack до `Wave=FROZEN`.

Після freeze достатній простий фізичний стан:

```text
packed
packedBy
packedAt
```

Revision-aware packing не потрібен, поки packing і seller-editing структурно не
перетинаються.

## 7. Standalone supplement

`Product` створюється тільки якщо routing справді має `warehouse=true`.

Для supplement-only item Wave child зберігає source snapshot із ReceiptItem і
`productId=null` є нормальним станом.

Не створювати технічний warehouse Product лише для foreign key.

## 8. Same-session ordinary exclusion

Якщо warehouse Product уже опублікований через SupplementWave для Session A, він
не повинен одночасно бути ordinary-orderable у Session A.

Це session-scoped exclusion. Для наступного ordinary cycle він живе за звичайними
warehouse/catalog rules.

## 9. Завершення доставки

`OrderingSession` — delivery-cycle owner:

```text
ordinary Orders / PickingTasks terminal
AND
усі SupplementWave цієї session terminal
-> session may complete
```

Стара чи чужа Wave не блокує нову session.

## 10. Зміна topology

Shop -> DeliveryGroup не може від'єднати магазин від поточної доставки, якщо
поточна exact OrderingSession має active Wave. Wave ownership ніколи не мігрує
разом із CURRENT topology.

## 11. Помилковий маршрут у Накладній

Published item не unconfirm/delete/recreate.

UI залишається простим:

```text
[ Редагувати ]

в редакторі:
[ Скасувати ] [ Зберегти ]
```

`Зберегти` зміненого confirmed routing викликає canonical
`CorrectReceiptItemRouting`:

```text
stop wrong supplement item
cancel unfinished requests
preserve packed physical facts/history
apply new ReceiptItem.routing
invoke canonical artifacts of new route
re-evaluate affected Wave / OrderingSession
```

Completed Wave history не переписується. Routing можна виправити для подальшого
життя товару. Якщо active Wave item лишається supplement, correction також
синхронізує його `productId/sourceSnapshot`: `warehouse=true` дає реальний Product,
`warehouse=false` повертає child у валідний standalone `productId=null` стан.

Seller UI для cancelled item показує просто `Скасовано`.

## 12. Історія / Зміна

Нову систему історії не створюємо.

Existing `Зміна` отримує read projection з двох джерел:

```text
PickingTask                 -> ordinary work
SupplementRequest.packedBy  -> supplement work
```

Одиниці не змішуються:

```text
Звичайні задачі: N
Дозамовлення: M магазинів
```

Хронологія працівника одна.

## 13. Notifications

Telegram lifecycle належить Wave, а не кожному товару.

```text
wave opened
wave reminder (optional)
wave frozen
```

Одна Wave з 20 товарами не створює 20 повідомлень. Idempotency зберігається на
Wave.

## 14. Фізична локація

Wave не є фізичним Block.

Якщо item має warehouse Product, location читається з канонічного
`Block.productIds`. Переміщення Product не змінює Wave identity.

## 15. Compatibility

Legacy rows:

```text
SupplementOffer.waveId = null
```

продовжують старий lifecycle через compatibility endpoints/scheduler. New Wave
writes не повинні випадково потрапляти в legacy per-offer notifications або
legacy automatic freeze.

## 16. Заборонені патерни

- browser timer як lifecycle authority;
- packing Wave item до freeze;
- `packed=true` як нормальний seller-edit lock;
- fake Product для supplement-only;
- CURRENT topology як ownership existing Wave;
- group-only new Wave queries без exact `orderingSessionId`;
- old/session-foreign Wave як blocker нової delivery session;
- per-product Telegram lifecycle spam;
- physical Block як реалізація віртуального supplement work;
- unconfirm/delete/recreate published ReceiptItem для correction.
