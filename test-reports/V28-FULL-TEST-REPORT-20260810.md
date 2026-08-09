# V28 — повний acceptance-звіт

Дата: 2026-08-10  
Середовище: TEST Atlas `cluster0.epfky0s.mongodb.net/tg_manager`  
Інструкція: `per-group-ordering-schedule-v28-INSTRUCTIONS.md`  
Backup перед тестами: `.dev-run/pre-v28-tests-20260810-000051`

## Вердикт

### Основний no-loss / picking acceptance: PASS

- Functional LIVE E2E: **14/14 scenarios**, **250/250 assertions**.
- MASS LIVE E2E: **762/762 assertions**, cleanup 0 leftovers.
- Усі створені замовлення дійшли до terminal business status.
- Усі operational OrderItem отримали terminal marker.
- 0 locked PickingTask, 0 unreconciled OOS task, 0 активних дублікатів.
- V27 hidden/unterminated-item bug реально виправлений: repair терміналізує позицію і closure стає clean.

### Повний V28 GREEN: FAIL через один окремий контракт

Заявлений fix видалення порожньої DeliveryGroup не працює після штатної materialization `OrderingSession`. Навіть повністю порожня pending-сесія автоматично має event `type: created`; DELETE трактує будь-який event як історію та повертає `409 group_has_history`. Отже V28 не виконує всі gates власної інструкції й не може називатися повністю green, попри green functional/MASS.

Продуктовий код і тести під результат не змінювалися.

## Матриця gate-ів

| Gate | Результат | Фактичний результат |
|---|---:|---|
| TEST DB backup | PASS | Повний mongodump створено до writes |
| Server `npm ci` | PASS | 685 packages; lockfile відтворюється |
| Server `npm test` | PASS | 19/19 files, 115/115 tests |
| Server `test:schedule` | PASS | 5/5 files, 35/35 tests |
| Server `test:v28:regressions` | PASS | 3/3 files, 17/17 tests |
| Server schedule smoke | PASS | `v28 per-group schedule + harness smoke: PASS` |
| Migration dry-run | PASS | 3 groups; need migration: 0 |
| Client `npm ci` | PASS | 720 packages; lockfile відтворюється |
| Client tests | PASS | 10/10 files, 37/37 tests |
| Client build | PASS | 3045 modules; build 17.56 s |
| Local/public API health | PASS | local + Cloudflare HTTP 200; maintenance inactive |
| Public mini-app | PASS/LIMITED | HTTP 200, UI дійшов до штатного Google auth gate |
| Live schedule A | PASS | delivery Monday; Tue 10:15 → Thu 09:45 |
| Live schedule B | PASS | Friday 18:00 → Sunday 20:30; delivery Monday |
| Live schedule C | PASS | invalid weekly cycle rejected HTTP 400; prior values preserved |
| Functional preflight | PASS | TEST guard, schedules, indexes, transaction, Redis isolation, no leftovers |
| Functional E2E | PASS | 14/14 scenarios; 250/250 assertions |
| MASS preflight | PASS | 100 sellers / 120 shops / 240 products / 12 workers ready |
| MASS full | PASS | 762/762 assertions; cleanup 0 leftovers |
| Terminal-order repair repro | PASS | repair → item cancelled → Order stays fulfilled → closure ok |
| Historical group DELETE | PASS | real Order/history → HTTP 409 `group_has_history` |
| Empty materialized group DELETE | **FAIL** | empty pending session → HTTP 409 instead of cascade-delete |
| Post-test DB audit | PASS relative to baseline | 0 new fixtures/orphans/mismatches/duplicates |

## Підтвердження виправлень V27

### Runtime closure repair

Окремий TEST Atlas repro:

```text
before.ok = false
before.blockers = coverage_gaps, unterminated_items

repair.cancelledCount = 1
repair.archived = true

Order.status = fulfilled
OrderItem.cancelled = true
OrderItem terminal = true
Product.status = archived

after.ok = true
after.blockers = []
```

Тобто terminal Order не повертається в роботу, невидима позиція отримує terminal marker, сесія більше не зависає.

### Functional harness

V27 падав до створення Orders через invalid synthetic deliveryDay. V28 helper пройшов production-validator і всі 14 сценаріїв реально виконали:

```text
order → current session → conflict gate → picking start → tasks
→ short pick / OOS / recovery / hidden repair → closure → completed
```

Пройшли `happy`, `remove_last`, усі conflict flows, `coverage`, `isolation`, `barrier`, `short_pick`, `oos`, `late_order`, `recovery`, `hidden_item`, `group_mismatch`.

### Windows client tests і lockfiles

Колишні suite-load failures виправлені:

- `pickingShopProducts.contract.test.js`: 3/3;
- `registrationLiveGate.contract.test.js`: 3/3.

Обидва справжні `npm ci` завершилися exit 0 без `npm install` або ручної зміни lockfile.

## Знайдений V28 defect: empty-session cascade недосяжний

Точний live API repro:

1. Створена нова DeliveryGroup без магазинів.
2. `GET /api/picking/session-status` матеріалізував рівно одну OrderingSession.
3. Перед DELETE:

```text
pickingStatus = pending
seq = null
openNotifiedAt = null
orders = 0
tasks = 0
catalogReviews = 0
events = [{ type: "created", by: "", byName: "" }]
```

4. `DELETE /api/delivery-groups/:id` повернув:

```text
HTTP 409
error = group_has_history
```

Причина: `routes/deliveryGroups.js` вважає intrinsic history будь-який непорожній `events`, але штатне створення OrderingSession завжди додає системний `created` event. Тому сесія, яка за бізнес-контрактом є порожньою materialized session, ніколи не проходить cascade.

Рекомендоване виправлення: системний початковий `created` event без actor/meta не повинен сам по собі робити сесію історичною, якщо одночасно немає seq, notification, lifecycle progress, Orders, Tasks або CatalogReview. Потрібен поведінковий API regression-test, не лише source-text contract.

Контрольний тест із реальним `fulfilled` Order підтвердив іншу половину контракту: DELETE правильно повертає `409 group_has_history` і не видаляє історію.

## MASS результат

RUN_ID: `20260809222241-268a8f`, seed `2389115844`.

```text
100 sellers
120 shops
240 products
12 blocks
12 concurrent warehouse workers
20 positions per initial Order
762 passed / 0 failed assertions
cleanup: 0 leftovers
```

Підтверджено:

- усі 100 initial Orders в одній current session;
- після concurrent submissions рівно 1 active Order на seller/shop/session;
- 0 duplicate product rows у Orders;
- усі operational OrderItem terminal;
- усі operational Orders terminal;
- 0 locked tasks;
- 0 unreconciled completed OOS tasks;
- 40/40 товарів цілих OOS-блоків архівовані;
- short-pick дані збережені у 9 Orders;
- hidden coverage gap знайдений, repaired і перестав блокувати closure.

Performance під віддаленим TEST Atlas:

- order POST: p50 11.9 s, p95 12.8 s;
- complete POST: p50 12.2 s, p95 15.2 s;
- OOS POST: p50 12.6 s, p95 14.7 s;
- closure poll: p50 2.1 s, p95 3.0 s.

Це не спричинило assertion failures, але latency варто окремо оцінити перед production load.

У MASS stderr був один transient Mongo `Write conflict` у конкурентному orphan-archive path. Фінальні перевірки підтвердили 0 unreconciled OOS і повну terminalization, тобто recovery спрацював. Повідомлення `socket ... null` належать ephemeral Express test app без Socket init і не вплинули на DB invariants.

## Cleanup та фінальна цілісність DB

Після V28:

```text
V28/LIVE_E2E groups       0
shops                     0
products                  0
users                     0
orders                    0
blocks                    0
shop audit logs           0
catalog reviews           0

active Orders без session             0
active PickingTasks без session       0
Order/session group mismatch           0
PickingTask/session group mismatch     0
duplicate active Order keys            0
duplicate active PickingTask keys      0
terminal Orders з nonterminal items    0
```

Один orphan OrderingSession `6a78eb974567e979299c192e` і manifest `live-e2e.run.20260809213015-e91ef0` існували вже у pre-V28 backup. V28 не створив нових orphan/manifest leftovers; старі V27 записи не видалялися.

Зауваження до інструкції: `npm run test:live:e2e:cleanup` без `--runId` не є універсальним pre-clean — команда завершується exit 1 і вимагає точний RUN_ID. Preflight окремо підтвердив відсутність fixture leftovers перед запуском.

## Dependency/security warnings

Встановлення відтворюється, але `npm ci` повідомив:

- server: 30 vulnerabilities — 1 low, 14 moderate, 12 high, 3 critical;
- client: 22 vulnerabilities — 2 low, 8 moderate, 11 high, 1 critical.

`npm audit fix --force` навмисно не запускався, бо це змінило б dependency tree поза acceptance scope. Потрібен окремий контрольований security/dependency review.

## Сирі артефакти

- Functional JSON: `server/test-reports/live-e2e-20260809222048-4d089f.json`
- Functional MD: `server/test-reports/live-e2e-20260809222048-4d089f.md`
- MASS MD: `server/test-reports/live-e2e-mass-20260809222241-268a8f.md`
- Backup: `.dev-run/pre-v28-tests-20260810-000051`
- Живий TEST stack: `.dev-run/20260810-001133`

## Що потрібно для повного GREEN

1. Виправити empty-session history predicate для єдиного системного `created` event.
2. Додати live/behavior regression: materialize empty session → DELETE 200 → group 0 → sessions 0.
3. Залишити окремий regression: session з Order/history → DELETE 409 → нічого не видалено.
4. Виправити документацію cleanup або додати безпечний універсальний scan mode.
5. Повторити server tests, live deletion smoke, functional 14/14 і MASS. Основний no-loss pipeline уже green; повтор потрібен, щоб нова зміна DELETE не дала regression.

