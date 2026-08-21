# Дозамовлення — канонічна архітектура V48.S3

## 1. Доменний сенс

Дозамовлення — тимчасовий додатковий канал замовлення товарів для **однієї
конкретної поточної доставки**. Воно не відкриває ordinary ordering назад і не
визначає довгострокову долю товару.

Довгостроковий маршрут завжди належить `ReceiptItem.routing`:

```text
supplement=true, warehouse=false
  -> дозамовлення цієї доставки; warehouse Product не потрібний

supplement=true, warehouse=true
  -> дозамовлення цієї доставки + звичайне складське життя товару

supplement=false, warehouse=true
  -> тільки складський потік
```

`mandatory + supplement` для однієї позиції невалідний.

Операційний lifecycle одного ReceiptItem:

```text
READY -> OPEN -> FROZEN -> COMPLETED
          \         \
           -> CANCELLED -> READY
```

`READY` означає: підтверджений supplement-маршрут ще не має активної або
використаної publication. Активний `FROZEN` блокує паралельний дубль, бо товар
уже пакують. Але `CANCELLED` звільняє позицію незалежно від попереднього
`OPEN/FROZEN`: якщо supplement-маршрут лишився, позиція повертається в `READY`
з новою чистою revision. Незворотним для автоматичного повтору є лише
`COMPLETED`.

**Скасування supplement publication не змінює routing.** Якщо товар має
`warehouse=true`, він лишається складським товаром після скасування дозамовлення.
Routing змінюється тільки окремою canonical командою `CorrectReceiptItemRouting`.

## 2. Один контейнер на Group + exact Session

```text
DeliveryGroup
  -> OrderingSession
      -> SupplementWave (СТАБІЛЬНИЙ КОНТЕЙНЕР)
          -> SupplementOffer (стабільний item-slot)
              -> revision 1, 2, 3, ...
                  -> SupplementRequest (Shop demand конкретної revision)
```

Для нових V48.S3 даних:

```text
SupplementWave.containerKey = hash(deliveryGroupId + orderingSessionId)
```

і це UNIQUE identity.

Тому для однієї групи та однієї exact `OrderingSession` немає кількох видимих
«пачок» дозамовлення. Нові товари, що приїхали пізніше, додаються до того самого
контейнера.

`SupplementWave.status` у V48.S3 — лише derived summary для compatibility/UI.
Він **не є seller lock і не є lifecycle authority окремого товару**.

Legacy `SupplementOffer.waveId=null` лишається окремим compatibility path.

## 3. Exact target без евристик

Ціль визначає `services/supplementTargets.js` із server-authoritative session
presentation.

Заборонено вирішувати target через:

```text
"зараз ранок"
"закрилось N хвилин тому"
"мабуть наступна група"
локальний годинник браузера
```

Працівник явно обирає DeliveryGroup. UI передає exact `orderingSessionId`, сервер
повторно перевіряє його під час publication command.

Future/not-started і historical sessions не приймають нову publication.

Звичайно `pickingStatus=completed` теж закритий. Є одна системна компенсуюча
межа: якщо **exact CURRENT OrderingSession** стала `completed` після скасування
publication, нова реальна publication може атомарно `completed -> in_progress`
під session lifecycle lock. Це стосується скасування після `OPEN` або `FROZEN`;
`COMPLETED` позиція повторно не публікується. Після rollover стара session вже
не є CURRENT і ніколи не reopen-иться.

## 4. Item-slot і необмежені publication revisions

Один `ReceiptItem` у конкретному group+session container має один стабільний
`SupplementOffer` slot:

```text
waveId + receiptItemId -> UNIQUE
```

Після будь-якого `CANCELLED` слот може запускатися багато разів:

```text
revision 1 OPEN -> CANCELLED
revision 2 OPEN -> CANCELLED
revision 3 OPEN -> FROZEN -> COMPLETED
...
revision 100+
```

Поточна revision зберігається в `SupplementOffer.revision`, попередня metadata /
snapshot / lifecycle — у `revisionHistory`.

Повторний запуск після cancellation дозволений, якщо жодна current/history
revision цього ReceiptItem не була `COMPLETED`. Він:

1. архівує metadata поточної revision;
2. `revision += 1`;
3. бере **новий snapshot** із поточного `ReceiptItem`;
4. ставить item у `OPEN`;
5. не відновлює жодної старої заявки магазину.

Тому старі фото, ціна і результати не можуть просочитися в новий запуск.

`completed` revision у тій самій exact session не повторюється неявно generic
publication-командою. Повтор вже фізично виконаного товару — окрема бізнес-операція,
якщо така колись буде потрібна.

## 5. Snapshot товару

Кожна publication revision заморожує seller-facing snapshot:

```text
title
imageUrl
originalImageUrl
price
quantityPerPackage
aiDescription
```

Після cancellation працівник може змінити майбутні metadata ReceiptItem, якщо
немає іншої OPEN/FROZEN publication або іншого operational usage. Старий запуск
не переписується — його snapshot лишається історичним.

## 6. Item lifecycle — реальна authority

```text
OPEN -> FROZEN -> COMPLETED
  \-> CANCELLED
```

Lifecycle належить `SupplementOffer.status` **конкретної current revision**.

### OPEN

Seller може:

```text
CREATE request
UPDATE request quantity
DELETE/cancel own request
```

### FROZEN

`Передати відкриті позиції в роботу` заморожує **тільки OPEN item revisions** у
контейнері.

Після freeze цього item:

- seller CREATE/UPDATE/DELETE заборонені server-side;
- warehouse може claim/pack;
- інші item-slots контейнера не змінюються;
- новий товар пізніше може бути доданий як OPEN у той самий container.

Тому валідний стан:

```text
Чашка      FROZEN
Тарілка    COMPLETED
Серветки   OPEN
```

Нова Серветка не створює другу видиму Wave.

### COMPLETED

Усі current requests item revision фізично завершені. Якщо після `FROZEN` немає
жодної незкасованої заявки, пакувати нічого: revision стає `CANCELLED`, а не
`COMPLETED`, і може повернутися в `READY`.

### CANCELLED

Current publication revision завершена компенсаційно. Після скасування `OPEN`
або `FROZEN` товар знову `READY`, якщо його canonical supplement-маршрут лишився.
Якщо маршрут окремо зняли, товар переходить у `NONE`, а не в ready-pool.

## 7. Request identity і CRUD

Заявка належить Shop; seller/admin — actor/provenance.

```text
offerId + revision + shopId -> UNIQUE
```

Це головний fence від змішування результатів двох повторних запусків одного товару.

Canonical seller API має окремі команди:

```text
POST   /supplement/offers/:offerId/requests   -> CREATE
PATCH  /supplement/requests/:requestId        -> UPDATE
DELETE /supplement/requests/:requestId        -> CANCEL current request
```

Legacy upsert endpoint може лишатися тільки compatibility transport і не є
канонічною новою моделлю.

Quantity = requested demand, не guaranteed reservation. Fair allocation і stock
reservation не вигадуються.

## 8. Скасування однієї позиції

Admin/warehouse може скасувати current OPEN або FROZEN revision конкретного item.

```text
all current ACTIVE requests -> CANCELLED
packed=true fields          -> audit only on the CANCELLED row
item revision               -> CANCELLED
інші item-slots              -> без змін
```

Для current UI всі результати скасованої revision зникають. Старі request rows
не видаляються фізично і доступні лише history projection.

Повторний publish після скасованої `OPEN` або `FROZEN` revision створює
`revision+1` із нульовими current results. Попередні заявки та packed-факти
зберігаються тільки в історії попередньої revision.

## 9. Скасування всіх активних позицій

`Скасувати всі активні позиції` означає:

```text
кожна OPEN/FROZEN current item revision -> CANCELLED
all current ACTIVE requests             -> CANCELLED
packed fields                            -> audit only, not fulfilment
```

Сам `SupplementWave` container не видаляється: інші READY товари можуть пізніше
додаватися до цього exact group+session container. Кожен скасований ReceiptItem
може повернутися чистою revision; виконаний `COMPLETED` — ні.

## 10. Packing

Packing дозволений тільки коли **сам item revision** має `status=frozen`.

`packed=true` у ACTIVE/FROZEN revision — warehouse progress. Якщо revision штатно скасовано, поле лишається лише audit-фактом і cancelled request більше не є fulfillment.

Всі warehouse current reads/updates мусять перевіряти:

```text
offerId
+ current offer.revision
+ request.revision
+ offer.status=frozen
```

Стара revision ніколи не може бути випадково packed через current картку.

## 11. Standalone supplement і warehouse life

`Product` існує тільки якщо routing справді має `warehouse=true`.

Supplement-only:

```text
productId = null
sourceSnapshot = ReceiptItem publication snapshot
```

Supplement+warehouse:

```text
publication використовує snapshot
Product паралельно живе нормальним warehouse lifecycle для майбутніх cycles
```

Cancel supplement не архівує warehouse Product автоматично і не змінює routing.

## 12. Same-session ordinary exclusion

Якщо warehouse Product має активний OPEN/FROZEN або виконаний COMPLETED
supplement item у Session A, він не може бути ordinary-orderable в тій самій
Session A.

Exclusion session-scoped. Ця історія не блокує наступну ordinary session. Лише
Будь-яка скасована publication одразу знімає exclusion.

## 13. Завершення OrderingSession

Session closure не дивиться на derived `SupplementWave.status` як authority.

```text
ordinary Orders/PickingTasks terminal
AND
немає SupplementOffer current revision
  where exact orderingSessionId
  and itemStatus=active
  and status in [OPEN, FROZEN]
-> session may complete
```

Old/foreign/cancelled/completed supplement history нову session не блокує.

## 14. Topology / schedule guards

CURRENT topology не мігрує existing container/item ownership.

Поки exact session має OPEN/FROZEN supplement work:

- Shop не можна переносити так, щоб current work відірвався від ownership;
- DeliveryGroup schedule не можна змінити так, щоб current session identity
  переключився під живою supplement роботою.

Це blockers destructive/current-cycle mutation, а не blockers наступної delivery
session після завершення старої.

## 15. Route correction — окрема state machine

`Cancel supplement item` і `CorrectReceiptItemRouting` — різні команди.

Route correction:

```text
OPEN seller input -> 409, ZERO MUTATIONS
FROZEN + supplement remains -> keep current requests
FROZEN + supplement removed -> annul ALL current requests
apply allowed ReceiptItem.routing
invoke canonical artifacts of new route
recompute container summary in the SAME Mongo transaction
re-evaluate OrderingSession after commit
```

Physical Warehouse guards remain independent: a Product that is/was shelved or has
Order/Picking history cannot lose `warehouse` through Receipt routing correction.
Routing correction never calls Archive.

Немає post-commit `.catch(() => {})` lifecycle transition, від якого залежить
session closure.

Якщо routing лишається supplement, active child може бути синхронізований із
warehouse/standalone shape. Historical cancelled/completed snapshots не
переписуються.

## 16. Warehouse statistics і history

Current operational projections завжди revision-scoped.

History projections навпаки можуть показувати всі revisions.

Warehouse demand estimate:

- будь-який cancelled historical request не рахується як current demand, навіть якщо в audit лишився `packed=true`;
- current active request рахується;
- completed/shift history може окремо показувати фактичну роботу та факт подальшого cancellation.

Shift history може показувати packed work усіх revisions тієї exact session, бо
це історія виконаної фізичної роботи, а не current seller state.

## 17. Notifications

Lifecycle notification належить **активності group+session container**, а не
кожному товару окремим Telegram spam.

`activityRevision` інкрементується кожною реальною publication-командою, яка
додала/restarted хоча б один item.

Notification claims revision-based:

```text
openedNotifiedRevision
frozenNotifiedRevision
cancelledNotifiedRevision
lastReminderRevision
```

Тому 50-й повторний запуск у тому самому container не блокується lifetime
`notifiedTypes` із першого запуску.

## 18. UI/UX contract

Користувач не бачить технічні `Wave #`, `revision #`, `batch #`.

Warehouse/admin бачить один блок:

```text
Дозамовлення групи

Чашка      Приймає заявки
Тарілка    У роботі
Серветки   Приймає заявки
```

Дії:

```text
Передати відкриті позиції в роботу
Скасувати позицію
Скасувати решту позиції   // frozen
Скасувати всі активні позиції
```

Скасований OPEN або FROZEN item знову стає доступним до publication через
receiving UI, якщо supplement-маршрут позиції не знято.

## 19. Compatibility

Legacy:

```text
SupplementOffer.waveId = null
```

залишається старим compatibility lifecycle. V48.S3 migration:

- modern old rows отримують `revision=1`;
- кілька старих S2 Wave одного group+session детерміновано зливаються в один
  container;
- secondary Wave docs лишаються merge tombstones;
- історичні requests не видаляються;
- critical `syncIndexes()` замінює lifetime indexes на container/revision identity.

## 20. Заборонені патерни

- lifetime `receiptItemId + deliveryGroupId` uniqueness для modern publication;
- створення другої modern Wave для того самого `DeliveryGroup + OrderingSession`;
- глобальний `Wave.status` як seller lock;
- resurrection старих requests у нову revision;
- current request query без revision fence;
- browser polling/timer як lifecycle authority;
- time-of-day/minutes-since-close target heuristics;
- cancel supplement як прихована зміна `ReceiptItem.routing`;
- destructive deletion history для «чистого UI»;
- rewrite packed physical facts;
- old/session-foreign supplement state як blocker нового cycle;
- per-product Telegram lifecycle spam;
- fake warehouse Product для supplement-only.
- readiness, порахована лише в межах вибраної target session;
- повернення ReceiptItem у ready-pool, поки його current revision ще активна
  FROZEN, або після фактичного COMPLETED.


## 21. V48.S3.1 — metadata correction is not lifecycle cancellation

For the same `ReceiptItem`, ordinary metadata correction is an UPDATE of the same
business item, not a new supplement publication:

```text
photo / price / qtyPerPackage / totalQty / comments / name / description
        -> keep current request quantities
        -> keep current revision
        -> update current OPEN/FROZEN sourceSnapshot
```

`totalQty` remains receiving metadata. `qtyPerPackage` describes the contents of a
package; warehouse packing is by packages, so S3.1 deliberately does **not** add
`packSizeAtPacking` or `packedUnits` accounting.

Shared commercial metadata for receipt-derived goods has one write authority. A
change from Receipt UI, warehouse Product UI or ShopProduct mirror converges through
`ReceiptItem` and propagates transactionally to Product/ShopProduct and current
OPEN/FROZEN supplement snapshots. CANCELLED/COMPLETED revision snapshots are history
and are not rewritten.

Only explicit lifecycle commands or a routing correction that removes the
`supplement` channel cancel current supplement demand. A route correction that keeps
`supplement` (for example `supplement -> supplement+warehouse`) preserves requests.

Seller and staff cancellation provenance is distinct:

```text
seller_cancelled -> seller may restore while item OPEN
staff_cancelled  -> seller restore forbidden
staff restore    -> explicit command, OPEN current revision only
```

This prevents a user with seller and staff capabilities from cancelling with staff
authority and then bypassing that decision through the seller interface.
