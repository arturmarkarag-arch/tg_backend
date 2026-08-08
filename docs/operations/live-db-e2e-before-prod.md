# LIVE DB E2E перед продом — order → picking → closure

Це **не mock suite**. Скрипт `scripts/liveOrderPickingE2E.js` підключається до `MONGODB_URI`, створює власний synthetic світ і проходить реальні Express routes / Mongoose models / Mongo transactions / production indexes.

## Безпека

- Реальні продавці, магазини, групи, товари та замовлення **не використовуються як fixtures**.
- Кожен прогін має `RUN_ID` і випадковий marker `__LIVE_E2E__<RUN_ID>`.
- Створюються окремі тестові `DeliveryGroup`, `Shop`, `User`, `Product`, `Block`, `OrderingSession`, `Order`, `PickingTask`.
- Telegram IDs тестових користувачів — synthetic negative namespace `-99...`.
- Глобальний production `orderNumber` counter **не витрачається**: тільки в тестовому процесі allocator перехоплений на synthetic 9xx,xxx,xxx range.
- `REDIS_URL` у тестовому процесі навмисно вимкнений. Suite перевіряє live MongoDB, реальні routes, transactions та indexes, але **не чіпає production Redis/cache/locks**.
- Test-only `session-seq:<syntheticGroupId>` counter реальний, але видаляється разом із fixture.
- На старті `--execute` у `AppSetting` створюється аварійний manifest `live-e2e.run.<RUN_ID>` з точними IDs. Якщо SSH/process впав, cleanup працює тільки по цьому manifest + точному random marker.
- За замовчуванням fixtures видаляються після кожного сценарію. `--keep-on-failure` використовувати тільки коли треба вручну подивитися failed fixture.

> Скрипт не змінює глобальний ordering schedule. Для переходу order → picking він змінює `dayOfWeek/openDate/openAt` **тільки synthetic group/session**, зберігаючи той самий session `_id`.

## Запуск

Спочатку тільки read-only preflight:

```bash
npm run test:live:e2e:preflight
```

Preflight перевіряє:

- live Mongo connection;
- `ordering.schedule`;
- що зараз можна створити synthetic ordering window і synthetic closed phase;
- критичні live indexes;
- Mongo transaction round-trip;
- наявність старих E2E leftovers;
- ізоляцію Redis.

Потім повний прогін:

```bash
npm run test:live:e2e
```

Або напряму:

```bash
node scripts/liveOrderPickingE2E.js --execute
```

Окремі сценарії:

```bash
node scripts/liveOrderPickingE2E.js --execute --scenario=happy,conflict_move,isolation,hidden_item
```

## Аварійний cleanup

На початку execute-run скрипт друкує:

```text
RUN_ID: 20260807224300-abcdef
```

Dry-run cleanup:

```bash
node scripts/liveOrderPickingE2ECleanup.js --runId=20260807224300-abcdef
```

Реальне видалення **тільки цього прогону**:

```bash
node scripts/liveOrderPickingE2ECleanup.js --runId=20260807224300-abcdef --execute
```

Cleanup відмовиться від роботи, якщо exact manifest не знайдено. Ніякого broad regex cleanup без manifest немає.

## Сценарії

1. **happy** — один seller створює Order; повторна відправка merge'иться в той самий Order; live partial unique index окремо відхиляє другу active Order; ordering phase закривається; pre-start; confirm; PickingTasks; claim; heartbeat; progress; complete; auto-next; `fulfilled`; session `completed`; closure clean.
2. **remove_last** — продавець видаляє останню позицію до picking; never-lived Order видаляється, а не лишається fake `cancelled`.
3. **conflict_move** — два buyers одного shop блокують start; seller переноситься в active shop, де вже є seller без Order; conflict зникає; picking стартує.
4. **conflict_relocate** — seller дозволено перенести навіть у shop з чужою active Order; conflict переїжджає на target shop і **далі блокує start**; після unassign старт дозволено.
5. **conflict_unassign** — conflict → unassign; Order стає parked; picking стартує; parked Order — warning, не closure blocker.
6. **coverage** — ordered Product зникає з block перед стартом; coverage gap видно і start блокується; repair terminal-cancel/archive; empty session завершується.
7. **isolation** — old session має active Order + pending PickingTask того самого product/group; current session все одно створює свій task, стартує і завершується; old debris лишається warning.
8. **barrier** — worker B бере позицію попереду; worker A доганяє і отримує `worker_ahead`, без перестрибування; після завершення B session закривається.
9. **short_pick** — ordered 5, physically packed 3; `packedQuantity=3`, `shortfallReason=short_pick`, Order terminal.
10. **oos** — один shop уже отримав товар, інший ні; OOS зберігає packed факт першого, cancels unserved remainder, archives Product, потім session cleanly completes.
11. **late_order** — після frozen picking plan synthetic late Order з двома товарами: товар зі ще pending task ride-along; недосяжний товар стає explicit `skipped`, а не невидимим blocker.
12. **recovery** — симуляція crash-window після `completionReason=out_of_stock`, але до archive; canonical recovery знаходить task, archives Product, terminalizes Order, closes session.
13. **hidden_item** — після build плану в Order з'являється live item без PickingTask; completion не мовчить: показує `coverage_gaps + unterminated_items`; repair після цього дозволяє closure.
14. **group_mismatch** — session/task/order identity corruption: `session_identity_invalid`, `session_task_group_mismatch`, `session_order_group_mismatch` видимі як blockers; після repair session завершується.

## Що означає PASS

PASS означає, що на **живій MongoDB** пройшли реальні write paths та production constraints для synthetic fixtures. Це сильніша перевірка за unit/mock tests, але це не production load test: Redis навмисно ізольований, і suite не генерує сотні одночасних реальних клієнтів.

Після прогону дивись:

```text
test-reports/live-e2e-<RUN_ID>.md
test-reports/live-e2e-<RUN_ID>.json
```

Перед завтрашнім стартом приймаємо тільки результат:

- `0 failed scenarios`;
- `0 failed assertions`;
- `cleanup OK` у кожного scenario;
- після run немає manifest `live-e2e.run.<RUN_ID>` (якщо не використовувався `--keep-on-failure`).

---

## MASS / intertwined run — «реальна зміна», а не один edge-case

14 сценаріїв вище доводять окремі контракти. Вони НЕ є навантажувальним доказом того, що багато незалежних станів нормально співіснують в одній сесії. Для цього є окремий:

```bash
npm run test:live:e2e:mass:preflight
npm run test:live:e2e:mass
```

Default mass profile:

- 100 продавців одночасно оформлюють замовлення;
- 120 synthetic магазинів в одній DeliveryGroup;
- 240 товарів у 12 фізичних Blocks;
- 12 складників працюють паралельно;
- по 20 позицій у первинному Order;
- два «гарячі» товари присутні майже у всіх 100 Orders;
- 25 sellers одночасно роблять по 3 повторні POST у своє замовлення;
- 10 магазинів перед стартом мають по 3 різних buyers → conflict gate;
- конфлікти розв'язуються паралельними move;
- в БД навмисно є stale Orders + orphan PickingTasks старої session;
- 12 складників одночасно претендують на один task → один winner;
- progress PATCH конкурує з complete;
- OOS конкурує з normal complete;
- recovery відтворює crash між OOS task completion і archive;
- late Orders одночасно містять уже пройдений і ще pending товар;
- два повні Blocks переводяться в OOS, тому після `$pull` стають порожніми;
- частина позицій short-pick;
- паралельно йдуть read polls closure/locked tasks;
- навмисно інжектяться hidden OrderItem, wrong-group PickingTask і wrong-group Order;
- closure повинна показати всі blockers, після explicit repair session повинна дійти до `completed`;
- в кінці перевіряються zero active locks, zero unreconciled OOS, terminality усіх operational OrderItems і zero leftovers після cleanup.

Mass suite пише latency p50/p95/p99/max для основних HTTP endpoints у:

```text
test-reports/live-e2e-mass-<RUN_ID>.md
test-reports/live-e2e-mass-<RUN_ID>.json
```

### Масштаб можна збільшити без зміни коду

```bash
LIVE_E2E_MASS_SELLERS=150 \
LIVE_E2E_MASS_SHOPS=180 \
LIVE_E2E_MASS_PRODUCTS=400 \
LIVE_E2E_MASS_BLOCKS=20 \
LIVE_E2E_MASS_WAREHOUSE=16 \
LIVE_E2E_MASS_ITEMS_PER_ORDER=25 \
npm run test:live:e2e:mass
```

Перед продом рекомендований мінімум: **14/14 functional E2E + 1 clean default MASS run + 0 leftovers**.
