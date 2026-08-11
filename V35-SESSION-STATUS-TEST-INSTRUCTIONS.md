# V35 — Session status / counters / schedule guard — інструкція перевірки

Дата: 2026-08-11

## Що саме перевіряємо

V35 закриває чотири окремі дефекти одного класу:

1. completed session у шапці показувала `0/0`, бо CLIENT очікував поля, яких SERVER не повертав;
2. група зверху могла показувати `Збирається`, тоді як сама OrderingSession уже `completed/Зібрано`, бо badge виводився з `hasRelocatedOrders`, а не з lifecycle session;
3. зміна розкладу була заблокована назавжди самим фактом існування історичних Orders/Tasks completed-сесії;
4. старі session з `seq:null` потребують одноразового backfill. Runtime для нових замовлень уже присвоює seq.

## 0. Перед тестом

Рекомендований порядок:

1. backup PROD;
2. restore latest PROD backup -> TEST;
3. invalidate Redis DB-derived cache / restart TEST backend;
4. ставимо V35 SERVER + V35 CLIENT;
5. усі write/live тести тільки на TEST.

## 1. Статичні/unit контракти

PowerShell:

```powershell
cd "C:\Users\danza\Downloads\tg bot\NEW_VERSION\server"
npm run test:v35:session
```

Очікування: усі тести PASS.

Особливо перевіряються:

- PROD-like counters: 540/540 tasks, 34/34 operational orders, 13/13 archives;
- interrupted OOS НЕ рахується як успішно архівований;
- group selector бере `phase` із server session presentation;
- selector більше НЕ читає `hasRelocatedOrders` як `Збирається`;
- schedule guard блокує тільки `new|in_progress` Orders, `pending|locked` Tasks та `confirmed|in_progress` session lifecycle;
- completed session не знімає target-session/reopen safety guards.

## 2. STRICT READ-ONLY діагностика TEST

```powershell
cd "C:\Users\danza\Downloads\tg bot\NEW_VERSION\server"
node scripts\diagnoseSessionState.js --all --env=..\arturmarkarag-db-user.env
```

Скрипт:

- не імпортує mongoose models;
- використовує native MongoDB driver;
- `secondaryPreferred`;
- write methods Collection hard-blocked через throw;
- НЕ викликає `getOrCreateSessionId`, тому не materialize-ить сесію.

Для конкретної групи:

```powershell
node scripts\diagnoseSessionState.js --group="Понеділок Достава" --env=..\arturmarkarag-db-user.env
```

Для конкретної сесії:

```powershell
node scripts\diagnoseSessionState.js --session=SESSION_OBJECT_ID --env=..\arturmarkarag-db-user.env
```

Для completed Monday-cycle очікуємо приблизно:

```text
pickingStatus: completed
PickingTasks: completed/packed=527 · completed/out_of_stock=13
OrderItems: OPEN=0
UI summary: опрацьовано товарів 540/540 · завершено замовлень 34/34 · архівовано 13/13
live blockers: orders=0 · tasks=0 · pickingLifecycle=no
VERDICT: CLEAN / terminal
V35 schedule-edit live guard: ... -> ALLOW
```

Якщо цифри відрізняються — НЕ виправляти БД вручну; спочатку дивимося конкретний blocker у звіті.

## 3. Номер сесії (`seq:null`)

### TEST dry-run

```powershell
node scripts\backfillSessionSeq.js --env=..\arturmarkarag-db-user.env
```

Нічого не записує. Має показати хронологічний план №1, №2, №3... окремо для кожної DeliveryGroup.

### TEST apply

Тільки якщо dry-run логічний:

```powershell
node scripts\backfillSessionSeq.js --execute --env=..\arturmarkarag-db-user.env
```

Після цього ще раз dry-run. Очікування: `РАЗОМ призначити: 0` і без seq/counter contradictions.

### PROD

Лише після TEST. За замовчуванням скрипт читає `NEW_VERSION\.env`:

```powershell
node scripts\backfillSessionSeq.js
node scripts\backfillSessionSeq.js --execute
node scripts\backfillSessionSeq.js
```

Перший і третій — dry-run.

## 4. UI acceptance

Відкрити `Збирання` -> `Понеділок Достава` після завершеного циклу.

Очікуємо:

```text
Понеділок Достава
Зібрано

Сесія збирання     [Зібрано]
Сесія №N · Сб 08.08
Опрацьовано товарів 540/540
Завершено замовлень 34/34
Архівовано товарів 13/13
```

Головне: верхній badge групи і badge самої сесії мають показувати ОДНУ фазу. Максимум 5 секунд на оновлення — список груп тепер poll-иться з тією ж cadence, що picking queue.

Під час живої сесії:

- `confirmed` / `in_progress` -> зверху `Збирається`;
- `completed` -> зверху `Зібрано`;
- pending + closed + Orders -> `Готово до збирання`;
- open ordering window -> `Замовлення відкриті`.

## 5. Перевірка schedule guard після completed session

На TEST змінити, наприклад, close/open time так, щоб новий розклад:

- НЕ відкривав назад уже completed current cycle;
- НЕ вказував на іншу історичну used session.

Очікуємо: PATCH проходить навіть якщо completed session має 34 fulfilled Orders і 540 completed Tasks.

Потім окремо перевірити три блокуючі сценарії:

1. є `Order.status=new|in_progress` -> 409;
2. є `PickingTask.status=pending|locked` -> 409;
3. session `pickingStatus=confirmed|in_progress` -> 409.

І два safety-сценарії, які V35 НЕ послаблює:

- новий schedule потрапляє в іншу вже used session -> 409;
- новий schedule повторно відкриває вже completed current cycle -> 409.

## 6. Existing LIVE E2E regression on TEST

Після вузьких V35 тестів:

```powershell
npm run test:live:e2e:preflight
npm run test:live:e2e
```

Це write-test, тому тільки TEST DB.

Acceptance: session identity, start, tasks, packing, OOS, closure, late orders — без регресії.

## 7. Що НЕ входить у V35

Окремий `Order ownership hardening` (магазин = власник Order, seller = immutable author; freeze shop/session після start picking) у цей пакет свідомо не змішувався. Це окрема зміна, яку спочатку погоджуємо й тестуємо окремою матрицею.
