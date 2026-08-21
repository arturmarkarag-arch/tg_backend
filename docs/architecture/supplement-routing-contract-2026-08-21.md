# Контракт маршруту ReceiptItem: Склад / Дозамовлення / Обов'язковий

**Дата:** 2026-08-21  
**Статус:** чинний після інциденту 2026-08-20

## 1. Головна модель

`Склад`, `Дозамовлення` і `Обов'язковий` — три незалежні бізнес-наміри одного ReceiptItem.
Вони можуть керувати одним і тим самим бізнес-товаром, але не можуть неявно знищувати
стан один одного.

Окремо існують:

1. **Routing** — що вирішили робити з привезеною позицією.
2. **Physical lifecycle** — чи існує фізичний Product, чи був він на полиці, у замовленні,
   у picking, чи архівований.
3. **Supplement lifecycle** — чи продавці зараз можуть подавати заявки, чи заявка вже
   передана складу, чи завершена/скасована.
4. **Visibility projection** — Product/ShopProduct, «Товари Магазинів», «Нові Товари».

Накладна задає і коригує routing. Вона **не є пультом керування вже запущеним
виробничим процесом**.

## 2. Видимість маршрутів

### Склад

`warehouse=true` створює/використовує фізичний `Product` і його warehouse mirror у
`ShopProduct`.

### Дозамовлення без Складу

`supplement=true && warehouse=false`:

- не створює фізичний `Product`;
- створює receipt-owned standalone `ShopProduct`;
- товар видно у «Товари Магазинів»;
- товар видно у «Нові Товари»;
- він не є звичайним seller-choice складським товаром.

### Обов'язковий без Складу

`mandatory=true && warehouse=false` має ту саму projection-модель:

- standalone receipt-owned `ShopProduct`;
- видно у «Товари Магазинів»;
- видно у «Нові Товари»;
- фізичного warehouse Product немає.

`Обов'язковий` **не має окремої production state machine**. Це простий маршрут/ознака
розподілу. Не створюємо штучних PLANNED/ACTIVE/COMPLETED станів для mandatory.

## 3. Архів не є routing

Archive означає фізичний факт: товару більше немає і його більше нічого віддавати.

Легітимні джерела:

- `manual_archive`;
- `out_of_stock`;
- аварійний `system_archive`.

Routing correction ніколи не:

- викликає Archive;
- знімає Product з Block;
- використовує Archive як cleanup артефакту.

Archive не переписує `ReceiptItem.routing`. Історичний маршрут лишається історичним
фактом.

## 4. Warehouse lifecycle і межа незворотності

До старту фізичного процесу `warehouse=true` може бути виправлено як помилковий план.
Технічний warehouse projection можна прибрати **лише якщо Product ще не набув жодного
фізичного/операційного факту**.

Зняти `warehouse` через накладну заборонено, якщо Product:

- зараз знаходиться у Block;
- **коли-небудь уже був поставлений у Block** (`firstBlockPlacedAt`);
- має ordinary Order history;
- має PickingTask history;
- уже archived.

Результат: `409 receipt_item_in_use`, zero mutations.

Таким чином працівник не може поставити товар на полицю, дати йому місце, а потім
прийти в накладну і «передумати», що це вже не Склад.

## 5. Supplement lifecycle

Canonical current стани ReceiptItem:

- `READY` / `WAITING_RECEIPT` — supplement лише запланований, продавці ще не пишуть;
- `OPEN` — seller input активний;
- `FROZEN` — seller input закритий, товар переданий у роботу складу;
- `COMPLETED` — terminal history;
- cancelled revision повертає item у clean READY, якщо `routing.supplement` лишився.

### OPEN — hard routing lock

Поки supplement `OPEN`, **будь-яка зміна routing підтвердженої позиції через накладну
заборонена**.

Причина проста: продавці зараз бачать товар і змінюють заявки. Накладна не може
переписати маршрут під живим seller process.

Відповідь сервера:

`409 receipt_supplement_route_open`

Працівник спочатку натискає «Передати в роботу», переводячи item у `FROZEN`.

### FROZEN — routing знову можна коригувати

`FROZEN` означає, що seller-side вже закритий. Склад працює з зафіксованими заявками,
тому routing можна коригувати.

Але фізичні Warehouse guards з §4 нікуди не зникають.

Якщо зміна **залишає** `supplement=true` (наприклад `Дозамовлення → Склад +
Дозамовлення`), поточні заявки не чіпаються.

Якщо зміна **прибирає** `supplement`, поточну non-terminal revision треба штатно
анулювати:

- усі `SupplementRequest status=active` цієї revision → `cancelled`;
- це стосується також рядків, які вже мали `packed=true`;
- packed-поля лишаються тільки audit-фактом cancelled revision і більше не є
  fulfillment;
- publication relation withdraw/cancel;
- Wave summary перераховується в тій самій Mongo transaction;
- після commit перевіряється session completion.

### COMPLETED — історичний факт, Supplement-прапорець незмінний

Після `COMPLETED` дозамовлення вже виконане. Через накладну заборонено як зняти
`supplement`, так і повторно ввімкнути його поверх completed history. Це не
блокує незалежні майбутні дії: наприклад, можна додати Warehouse remainder, якщо
це дозволено фізичним Warehouse lifecycle.

UI зобов'язаний показати `COMPLETED` як видимий стан із групою і поясненням, а не
просто зробити кнопку сірою. Сервер повторно гарантує цей інваріант через `409
receipt_supplement_already_completed`.

## 6. Помилились групою — штатне повне скасування і restart

Працівник може випадково відкрити дозамовлення не тій DeliveryGroup.

Це не виправляється підміною `deliveryGroupId` живої publication.

Правильна операція:

1. `Cancel` current item або whole active supplement container.
2. Анулювати **всі** current-revision seller requests, включно з packed-marked.
3. Залишити старі rows як immutable cancellation history.
4. Повторно опублікувати clean `revision+1` для правильної групи.

Сам `SupplementWave` container не видаляється; completed history не переписується.

## 7. Supplement target: тільки після ordinary ordering

Дозамовлення не конкурує зі звичайним вікном замовлень тієї самої групи.

Target rules:

- upcoming / session not started → заборонено;
- `ordering_open` → **заборонено**;
- `awaiting_picking` → дозволено;
- `picking` → дозволено;
- `completed` → лише існуючий already-supported recovery після persisted supplement
  cancellation exact current session; звичайний новий publish заборонений.

UI `selectable=false` недостатньо. `resolveSupplementTarget()` і publish endpoint мають
server hard guard `supplement_ordering_still_open`.

Окремий «double order» механізм не є доменним правилом: правильна межа — не дозволити
Supplement початися, доки ordinary ordering цієї групи ще відкрите.

## 8. Обов'язковий — не ускладнювати

`mandatory` можна перемикати як routing, якщо це не вимагає порушити інший реально
активний процес.

Тобто:

- OPEN Supplement все одно блокує всю route correction;
- фізичний Warehouse guard все одно блокує зняття Warehouse;
- але сам `mandatory` не створює production lock/state machine.

`mayNotReachAllShops` лишається атрибутом mandatory-only маршруту за існуючим
контрактом.

## 9. Routing correction не скасовує чужі сутності неявно

Заборонена модель:

`checkbox changed → auto archive / detach Block / silent request deletion`.

Canonical route correction:

1. read current ReceiptItem + all relevant process facts;
2. validate requested routing;
3. preflight lifecycle guards;
4. if blocked → `409`, zero mutations;
5. if allowed → one transactional correction of projections;
6. post-commit sockets/notifications only after successful commit.

`Cancel supplement item` і `CorrectReceiptItemRouting` — різні команди. Route
correction may invoke the canonical cancellation primitive **only after seller input
is closed and only when the requested routing explicitly removes supplement**.

## 10. Technical warehouse projection rollback

До першого physical/order/picking fact можна прибрати warehouse projection cleanly.
Це не Archive.

Ця операція може змінити тільки warehouse-owned artifacts:

- physical Product;
- warehouse mirror ownership;
- ProductVector ownership;
- `createdProductId` / `stockApplied`.

Вона не має права видалити `SupplementOffer`, `SupplementRequest` або standalone
ShopProduct іншого маршруту.

При `Склад → Дозамовлення/Обов'язковий` canonical ShopProduct identity треба
конвертувати/зберегти, а не видаляти й створювати без потреби новий каталоговий товар.

## 11. Identity

Один ReceiptItem може мати максимум один фізичний Product.

- `Product.receiptItemId` — durable identity anchor;
- partial unique index захищає від дубля;
- якщо `createdProductId` загубився, projector спочатку шукає Product за
  `receiptItemId`, а не створює новий;
- archived Product за цим anchor не «оживає» через routing correction.

Receipt-owned standalone `ShopProduct` теж не має незалежного delete lifecycle:
його не можна просто видалити у «Товари Магазинів», лишивши ReceiptItem route живим.

## 12. Archive reconciliation

Коли Product реально архівується, фізичного товару більше немає. Тому Archive має
право reconciliate незавершену роботу:

- unpacked ordinary OrderItem → cancelled за існуючими правилами;
- active current SupplementRequest цього Product → cancelled, включно з packed-marked
  audit rows;
- active SupplementOffer → cancelled/withdrawn;
- packed/completed terminal history не переписується як інша revision;
- `ReceiptItem.routing` не змінюється.

Archived Product не може бути опублікований новою supplement revision.

## 13. Concurrency

Одного precheck недостатньо.

Операції одного physical Product:

- place in Block;
- move between Blocks;
- remove from Block;
- Archive;
- Warehouse-detach through routing correction

мають спільну `product:<id>:physical-lifecycle` serialization boundary.

Lifecycle condition повторно перевіряється під lock/transaction перед write.

## 14. Batch routing

Перед **першим write** batch виконує preflight усіх confirmed rows.

Якщо хоча б один item blocked:

- відповідь `409 receipt_routing_batch_blocked`;
- zero business writes для звичайних lifecycle відмов;
- оператор бачить причину і змінює вибір свідомо.

Batch не маскує blocked rows у `200 partial success`.

## 15. UI

UI лише пояснює server authority:

- OPEN Supplement → всі routing controls disabled + причина;
- FROZEN → routing controls доступні;
- FROZEN + вимкнути supplement → explicit confirm, що всі current requests буде
  анульовано;
- Product у current Block → вимкнення Warehouse disabled із номером Block;
- сервер повторно перевіряє все незалежно від UI.

## 16. Мінімальні regression gates

1. shelf Product → remove warehouse через receipt = 409, no Archive, Block unchanged.
2. previously shelved Product, навіть уже знятий із Block → remove warehouse = 409.
3. Product with Order/Picking history → remove warehouse = 409.
4. OPEN supplement → будь-який route correction = 409.
5. FROZEN supplement + route retains supplement → allowed, requests unchanged.
6. FROZEN supplement + route removes supplement → all current requests cancelled,
   including packed-marked rows; clean revision may restart.
7. cancel wrong group → whole active revision annulled → republish correct group cleanly.
8. `ordering_open` group → supplement publish = 409.
9. supplement-only confirmed row → standalone ShopProduct + New Products visibility,
   no Product.
10. mandatory-only confirmed row → standalone ShopProduct + New Products visibility,
    no Product.
11. routing correction never calls Archive.
12. Archive cancels current ordinary/supplement demand without rewriting routing.
13. direct delete receipt-owned ShopProduct = 409.
14. concurrent shelf placement vs warehouse-detach cannot leave dangling Block.productIds.
15. duplicate physical Product for one ReceiptItem blocked by DB identity.
