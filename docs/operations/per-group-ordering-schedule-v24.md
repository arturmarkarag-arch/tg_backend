# v24 — індивідуальний розклад замовлень для кожної групи доставки

## Що змінилось

З v24 календар приймання замовлень більше НЕ береться з глобального `AppSetting('ordering.schedule')`.
Кожна `DeliveryGroup` має власний обов'язковий `orderingSchedule`:

```json
{
  "startDay": 6,
  "startHour": 16,
  "startMinute": 0,
  "endDay": 1,
  "endHour": 7,
  "endMinute": 30
}
```

- `dayOfWeek` лишився фізичним днем доставки.
- `startDay/startHour/startMinute` визначають початок ordering-session.
- `endDay/endHour/endMinute` визначають кінець приймання замовлень.
- хвилини дозволені тільки `00 / 15 / 30 / 45`.
- тижневе вікно може переходити через неділю/понеділок без спеціального хардкоду.
- Europe/Warsaw DST має детерміновану політику: відсутній весняний 02:xx переноситься вперед на DST-gap; повторний осінній 02:xx бере ранніший occurrence.
- ідентичність `OrderingSession` лишилась `{groupId + openDate}`.
- Orders, PickingTasks, OOS, conflicts, coverage та closure як і раніше прив'язані до `orderingSessionId`.

## ВАЖЛИВО: порядок першого локального запуску v24

### 0. Зробити backup TEST-бази

Не починайте з production. Спочатку TEST DB.

### 1. Швидкий dependency-light smoke ще до npm install

```bash
cd server
npm run test:schedule:smoke
```

Він перевіряє weekly math, незалежність двох груп, legacy Monday migration mapping, DST policy та відсутність runtime global-schedule utility.

### 2. Встановити залежності

Server:

```bash
cd server
npm ci
```

Client:

```bash
cd client
npm ci
```

### 3. НЕ запускати v24 server одразу на старій БД

У v24 є startup-preflight. Якщо хоч одна стара DeliveryGroup не має `orderingSchedule`, server навмисно відмовиться стартувати.

Спочатку dry-run міграції:

```bash
cd server
npm run migrate:group-schedules
```

Команда нічого не записує. Вона покаже для кожної старої групи, який розклад буде створено.

Міграція один раз копіює старі глобальні години і ТОЧНО відтворює стару поведінку дня старту, включно зі старим правилом для понеділка:

```text
Понеділок доставка -> старт у суботу
```

Цей special-case існує ТІЛЬКИ в migration helper, щоб перехід на v24 не змінив живу поведінку старих груп. Runtime v24 його більше не використовує.

Якщо старий глобальний `openMinute/closeMinute` не дорівнює `00/15/30/45`, міграція зупиниться. Це навмисно: v24 нічого не округлює мовчки.

### 4. Перевірити dry-run руками

Для кожної групи звірити:

- назву;
- фізичний `dayOfWeek`;
- start day/time;
- end day/time.

### 5. Застосувати міграцію

```bash
npm run migrate:group-schedules:apply
```

Після цього повторний dry-run має показати:

```text
need migration: 0
```

### 6. Запустити нові schedule-тести

```bash
npm run test:schedule
```

Очікування: 0 failed.

### 7. Запустити весь server test suite

```bash
npm test
```

Очікування: 0 failed.

### 8. Запустити server

```bash
npm run dev
```

У стартових логах має бути:

```text
[preflight] delivery-group schedules OK (...)
```

Якщо preflight падає — НЕ обходити його. Виправити/мігрувати конкретну групу.

### 9. Client

```bash
cd client
npm test
npm run build
npm run dev
```

У `Налаштування -> Групи доставки -> створити/редагувати` перевірити поля:

- День доставки;
- Початок сесії: день / година / хвилина;
- Кінець сесії: день / година / хвилина;
- хвилини тільки 00/15/30/45.

## Обов'язковий ручний smoke-test

Створити/взяти ДВІ тестові групи з різним графіком в один і той самий момент часу.

### Сценарій A — незалежність груп

- Group A: schedule, який зараз OPEN.
- Group B: schedule, який зараз CLOSED.

Перевірити:

1. Продавець Group A може замовляти.
2. Продавець Group B не може замовляти.
3. `Збирання` Group A блокується через відкрите ordering-window.
4. `Збирання` Group B не блокується календарем, якщо інші доменні gate-и пройдені.
5. `GET /api/picking/schedule?groupId=<A>` і `<B>` повертають різні schedule.

### Сценарій B — перехід через тиждень

Наприклад:

```text
Початок: П'ятниця 20:30
Кінець:   Понеділок 06:00
```

Перевірити, що в суботу/неділю ordering OPEN, а в понеділок після 06:00 CLOSED.

### Сценарій C — Monday legacy compatibility

На копії старої БД до міграції взяти понеділкову групу. Після migration її перший schedule має відтворювати старий старт у суботу та старі глобальні години. Це гарантує, що cutover сам по собі не пересуне існуючу сесію.

### Сценарій D — редагування під час активної роботи

Спробувати змінити schedule/dayOfWeek, коли:

- ordering window відкрите;
- є активний Order поточної/наступної сесії;
- є pending/locked PickingTask;
- pickingStatus = confirmed або in_progress.

Очікування: HTTP 409; група НЕ змінюється.

### Сценарій E — не воскресити завершену сесію

Після `pickingStatus=completed` спробувати пересунути розклад так, щоб новий schedule зробив старий цикл знову OPEN.

Очікування: HTTP 409.

### Сценарій F — stable session ID при безпечній зміні close-time

На порожній pending сесії, коли вікно закрите, змінити лише `endHour/endMinute`, не змінюючи start boundary.

Очікування:

- `OrderingSession._id` той самий;
- `openDate` той самий;
- для порожньої pending session оновлені `closeAt/scheduleSnapshot`;
- жоден Order/PickingTask не мігрується на іншу сесію.

## Live E2E після unit/integration tests

Тільки на TEST DB:

```bash
cd server
npm run test:live:e2e:preflight
npm run test:live:e2e
npm run test:live:e2e:mass:preflight
npm run test:live:e2e:mass
```

v24 E2E/MASS більше не змінюють глобальний `ordering.schedule`. Вони створюють synthetic DeliveryGroup зі своїм schedule і переводять тільки її з ordering-open у picking-closed phase.

Після тесту:

```bash
npm run test:live:e2e:cleanup
```

До production допускаємо тільки після звичних фінальних критеріїв:

- 0 failed;
- 0 conflict_retry;
- 0 unreconciled OOS;
- 0 locked leftovers;
- session completed;
- cleanup 0 leftovers.

## Що НЕ змінювалось

Навмисно не переписувались доменні правила:

- Order conflict;
- stale/old session isolation;
- PickingTask session scope;
- OOS reconciliation;
- forward-only picking;
- closure audit;
- session picking lifecycle.

Змінився календарний resolver перед ними: він тепер отримує explicit `DeliveryGroup.orderingSchedule` і повертає той самий тип `orderingSessionId`.

## Legacy setting

`AppSetting('ordering.schedule')` після migration можна тимчасово залишити в БД як історичну інформацію. Runtime v24 його не читає. POST глобального schedule API повертає 410.

Не видаляйте legacy setting ДО того, як старі групи успішно пройдуть one-time migration.
