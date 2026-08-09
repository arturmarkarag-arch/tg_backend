# v25 — індивідуальний розклад груп + delivery day = close day

Це продовження нашої v24. Основа session identity не змінена: `OrderingSession` як і раніше визначається через `{ groupId + openDate }`, а Orders/PickingTasks/OOS/conflicts/closure працюють через `orderingSessionId`.

## Що виправлено у v25

1. **День доставки = день закриття ordering-session.**
   - `DeliveryGroup.dayOfWeek` — канонічний день доставки і завершення сесії.
   - у формі більше немає окремого dropdown для `endDay`;
   - `orderingSchedule.endDay` лишився в БД/snapshot для самодостатності історії, але server/model примусово синхронізують його з `dayOfWeek`.

2. **Dropdown тижня починається з понеділка.**
   - UI: Понеділок → Вівторок → Середа → Четвер → П'ятниця → Субота → Неділя.
   - внутрішня нумерація не змінена (`0=Sunday ... 6=Saturday`), тому календарна математика не переписувалась.

3. **Збереження годин більше не повинно повертати старі значення.**
   - PATCH після `save()` перечитує групу з Mongo і повертає реально збережений документ;
   - client одразу мерджить PATCH response у canonical React Query cache, а потім робить background refetch;
   - доданий persistence test для nested `orderingSchedule`.

4. **Порожню групу можна переналаштувати навіть якщо за годинником її ordering-window зараз OPEN.**
   - сам факт `isOpen=true` більше не блокує редагування;
   - редагування все одно HARD BLOCK, якщо current/next session вже мають будь-які Orders, PickingTasks або picking lifecycle вийшов зі `pending`.
   - це дозволяє нормально конфігурувати TEST/нову групу в будь-який час, не ризикуючи живими замовленнями.

5. **Migration/preflight перевіряють новий контракт.**
   - якщо стара/v24 група має `orderingSchedule.endDay != dayOfWeek`, dry-run покаже repair;
   - `--apply` виправить тільки `endDay`, не змінюючи start/end hours;
   - runtime fallback як і раніше відсутній.

---

## 0. Використовувати тільки TEST DB

Перед запуском зроби backup TEST-бази. Production не чіпати до повного green.

## 1. Dependency-light smoke

```bash
cd server
npm run test:schedule:smoke
```

Очікування:

```text
✅ v25 per-group ordering schedule smoke: PASS
```

Він перевіряє:
- weekly math;
- quarter-hour validation;
- Monday legacy cutover mapping;
- DST Europe/Warsaw;
- `deliveryDay === endDay` canonicalization;
- synthetic open/closed schedules для live E2E;
- відсутність runtime global schedule.

## 2. Встановити dependencies

```bash
cd server
npm ci
```

```bash
cd client
npm ci
```

## 3. Dry-run migration / repair

```bash
cd server
npm run migrate:group-schedules
```

Нічого не записується.

Перевір кожну зміну. Для вже мігрованої v24 групи можливий repair такого типу:

```text
Delivery day = Monday (1)
orderingSchedule.endDay = Tuesday (2)
→ proposed endDay = Monday (1)
```

Години та start boundary при такому repair не змінюються.

Для зовсім старої групи без `orderingSchedule` migration використовує старий global setting лише ОДИН РАЗ для точного cutover. Runtime його не читає.

## 4. Apply migration

Тільки після перевірки dry-run:

```bash
npm run migrate:group-schedules:apply
```

Потім ще раз:

```bash
npm run migrate:group-schedules
```

Очікування:

```text
need migration: 0
```

## 5. Schedule test suite

```bash
npm run test:schedule
```

Очікування: **0 failed**.

Окремо цей suite перевіряє:
- per-group weekly calendar;
- `groupId + openDate` session identity;
- startup preflight;
- DB mismatch `endDay != dayOfWeek`;
- schema auto-sync `endDay -> dayOfWeek`;
- persistence нових `startHour/startMinute/endHour/endMinute`;
- session edit guards;
- відсутність Monday runtime hardcode.

## 6. Весь server suite

```bash
npm test
```

Очікування: **0 failed**.

## 7. Server startup

```bash
npm run dev
```

Має бути:

```text
[preflight] delivery-group schedules OK (...)
```

Якщо preflight падає — не обходити. Запусти migration dry-run і виправ конкретну групу.

## 8. Client tests/build

```bash
cd client
npm test
npm run build
npm run dev
```

Очікування: **0 failed**, build success.

---

# Ручна перевірка UI — обов'язково

Відкрий:

```text
Налаштування → Групи доставки → редагувати групу
```

Перевір:

### A. Порядок днів

У `День доставки / закриття сесії` і `Початок сесії → День тижня` dropdown має бути:

```text
Понеділок
Вівторок
Середа
Четвер
П'ятниця
Субота
Неділя
```

### B. Close day linked to delivery day

Наприклад:

```text
День доставки / закриття: Четвер
Початок: Вівторок 16:15
Кінець:  Четвер 07:45
```

У блоці `Кінець сесії / доставка` день `Четвер` має бути read-only, а редагуються тільки година та хвилина.

### C. Save persistence

Постав, наприклад:

```text
Початок: Середа 18:15
Кінець:  Четвер 09:45
```

Натисни `Зберегти`.

Після закриття рядка відкрий його знову.

**Має залишитись 18:15 → 09:45. Старі години повертатися не повинні.**

Також у collapsed summary має бути новий schedule.

### D. Empty/open-by-clock group

На TEST-групі без Orders/PickingTasks зміни години навіть якщо її ordering-window за поточним часом OPEN.

Очікування: save проходить.

### E. Group with real session data

Коли current або next session має хоча б один Order чи PickingTask, спробуй змінити schedule.

Очікування:

```text
HTTP 409
```

і зрозуміле повідомлення, що календар не можна змінити, бо сесія вже має реальні дані.

Це важливо: ми дозволили конфігурацію порожньої групи, але **не послабили захист живих session IDs**.

---

# Перевірка двох незалежних груп

Створи дві TEST-групи:

```text
A: start Monday 08:00 → delivery/close Tuesday 09:30
B: start Wednesday 15:15 → delivery/close Friday 07:45
```

Перевір:
- кожна повертає свій `/api/picking/schedule?groupId=...`;
- seller ordering gate кожної групи залежить тільки від її schedule;
- picking start кожної групи залежить тільки від її schedule/session;
- session IDs різних груп не змішуються.

---

# Live functional E2E

Тільки після unit/integration green:

```bash
cd server
npm run test:live:e2e:preflight
npm run test:live:e2e
```

Synthetic group у v25 також виконує контракт:

```text
delivery day === orderingSchedule.endDay
```

і переводиться OPEN → CLOSED без глобального schedule.

Після functional E2E:

```bash
npm run test:live:e2e:cleanup
```

Очікування: cleanup 0 leftovers.

# MASS

```bash
npm run test:live:e2e:mass:preflight
npm run test:live:e2e:mass
```

Фінальний критерій перед production:

```text
0 failed
0 conflict_retry
0 unreconciled OOS
0 locked leftovers
session completed
cleanup 0 leftovers
```

# Що НЕ переписувалось у v25

Не змінювались доменні контракти:
- Orders session scope;
- PickingTask session scope;
- conflicts;
- OOS reconciliation;
- forward-only picking;
- closure audit;
- historical/stale session isolation;
- `OrderingSession { groupId + openDate }` unique identity.

Змінено лише конфігураційний контракт DeliveryGroup і save/edit safety навколо календаря.
