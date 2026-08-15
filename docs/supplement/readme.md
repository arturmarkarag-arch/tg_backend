# Дозамовлення — актуальна логіка V47.16

## 1. Призначення

Дозамовлення — окремий потік для вже прийнятого товару, який продавці можуть
замовити поза звичайною сесією. Продавець сам вирішує, чи потрібен товар.

Це протилежно `Обов'язковому`, де рішення про розподіл приймає склад. Тому
`mandatory + supplement` для однієї позиції заборонено.

Дозамовлення не відкриває повторно `OrderingSession`, не змінює її id/status і
не може бути доступним продавцям паралельно з ordinary ordering тієї самої групи.

## 2. Підготовка товару ≠ публікація дозамовлення

Current regular receipt працює поетапно:

```text
ReceiptItem
  -> ціна + кількість в упаковці
  -> routing.supplement = true
  -> routing.supplementDeliveryGroupId = конкретна група
  -> confirm
  -> ГОТОВО ДО ПАЧКИ
```

Починаючи з V47.16, `confirm` для current per-item supplement **не створює
`SupplementOffer` і не надсилає Telegram-повідомлення**.

`ReceiptItem` отримує:

```text
supplementBatchVersion = 1
supplementPublishRequestedAt = null
```

Це означає: товар підготовлений, але ще не опублікований продавцям.

Legacy rows (`supplementBatchVersion=0`) залишають стару auto-open поведінку без
обов'язкової міграції. Старі `Receipt.type='supplement'` документи також
підтримуються.

## 3. Публікація пачки

У `Накладні -> Фото` сервер групує всі готові current supplement items за
`deliveryGroupId`.

Працівник бачить, наприклад:

```text
Понеділок Достава · 37 товарів
[ Відкрити 37 ]
```

Один клік на:

```text
POST /receipts/supplement-batches/:deliveryGroupId/publish
```

ставить `supplementPublishRequestedAt` одразу всім готовим товарам цієї групи.

### Якщо ordinary ordering уже закритий

Сервер створює всі `SupplementOffer` пачкою та викликає notification layer один
раз для всієї групи.

```text
37 товарів
-> 37 SupplementOffer
-> ОДНЕ Telegram-повідомлення для групи
```

### Якщо ordinary ordering ще відкритий

Публікація не блокується. Пачка стає запланованою:

```text
supplementPublishRequestedAt = now
Receipt.supplementStatus = pending
```

`SupplementOffer` продавцям ще не відкриваються. Після закриття ordinary window
хвилинний scheduler спочатку створює/доремонтовує всі offer-и, а потім один
notification pass групує всі `open + unnotified` offer-и за `deliveryGroupId`.
Отже delayed batch теж отримує одне групове повідомлення, а не повідомлення на
кожну позицію.

## 4. Дозамовлення + На склад

Це дозволена комбінація.

- supplement-only тримає технічний warehouse `Product` як стабільний `productId`
  для заявок/picking, але має `orderingEnabled=false`;
- такий технічний Product **не належить до `Надходження`** і не чекає розміщення
  в Block;
- `supplement + warehouse` має `orderingEnabled=true` і нормально з'являється в
  `Надходження` для майбутнього ordinary warehouse flow;
- якщо залишок з'ясувався пізніше, confirmed supplement можна доповнити через
  `add-warehouse-remainder` без recreating offer/request і без повторної розсилки.

`totalQty` не використовується для автоматичного висновку про залишок.

## 5. Життєвий цикл SupplementOffer

```text
open -> frozen -> completed
```

- `open`: магазини можуть створювати/міняти заявки;
- `frozen`: склад/адмін закрив хвилю або її автоматично заморожено при старті
  наступного ordinary ordering window цієї групи;
- `completed`: усі заявки спаковані або після freeze заявок не було.

Runtime gate seller API додатково не дозволяє бачити/міняти supplement, коли для
цієї групи вже відкрилось ordinary ordering.

## 6. Закриття хвилі

Regular receipt може містити supplement items для різних delivery groups. Freeze
завжди scoped по `receiptId + deliveryGroupId`; група A не заморожує B.

Scheduler також перевіряє всі `open` offers і заморожує старі хвилі при старті
наступного ordinary ordering window. Існуючі заявки не видаляються.

## 7. Заявка магазину

Одна заявка належить магазину, продавець зберігається як історичний автор.
Унікальна пара:

```text
offerId + shopId
```

Після `packed=true` продавець не може змінити/видалити заявку, доки склад не
зніме галочку.

## 8. Віртуальний блок

Віртуальний supplement block показує активні пропозиції групи та фізичну
локацію Product. Supplement-only технічний Product може мати location
`Надходження` в старих/legacy даних, але V47.16 ordinary `Надходження` placement
queue фільтрує `orderingEnabled=false` і не просить ставити такий товар у Block.

## 9. Кількість

Authoritative reservation/remaining-stock math для всіх сценаріїв поки немає.
Кількість прийомки зберігається як факт, але не визначає автоматично route або
`залишок -> На склад`.
