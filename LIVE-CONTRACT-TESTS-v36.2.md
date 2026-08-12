# Live contract tests v36.2

Цей набір запускається на тестовій MongoDB через той самий safety harness, що й існуючий `liveOrderPickingE2E.js`.
Всі fixtures синтетичні (`__LIVE_E2E__<runId>`), Redis у процесі тесту вимикається, після кожного сценарію дані прибираються.

## Спочатку preflight (нічого не створює)

```bash
npm run test:live:contracts:preflight
```

## Потім повний критичний набір

```bash
npm run test:live:contracts
```

Це запускає:

- `multi_seller_single_order` — 3 продавці на одному магазині дозволені; якщо замовив один, conflict немає.
- `ownership_freeze` — після `OrderingSession.closeAt` продавця можна перенести/відв'язати, але `Order.shopId`, `buyerSnapshot` та `orderingSessionId` не рухаються; picking будується для старого магазину.
- `checkbox_handoff` — галочка переживає release/перехоплення, зберігає `packedBy`; нова галочка належить новому складнику; duplicate complete не дає повторних side effects.
- `session_rollover` — той самий товар у наступній `OrderingSession` отримує новий `PickingTask`; packed/packedBy/packedAt старої сесії не протікають.
- `isolation` — старі активні Order/PickingTask не блокують нову сесію, але видимі як warnings.
- `barrier` — складник не перестрибує через task, заблокований іншим складником попереду.
- `coverage` — товар без фізичного блока блокує старт, explicit repair робить позицію terminal і дозволяє closure.
- `oos` — out-of-stock завершує правильні позиції та архівує товар без повторного застосування.
- `hidden_item` — прихована/випала позиція ловиться closure/coverage контрактом, а не губиться мовчки.

## Весь live E2E

Нові 4 сценарії також додані в загальний набір:

```bash
npm run test:live:e2e:preflight
npm run test:live:e2e
```

## Один сценарій

Наприклад тільки ownership:

```bash
node -r ../dev-use-test-db.js scripts/liveOrderPickingE2E.js --execute --scenario=ownership_freeze
```

Тільки handoff:

```bash
node -r ../dev-use-test-db.js scripts/liveOrderPickingE2E.js --execute --scenario=checkbox_handoff
```

## Якщо процес упав

Скрипт друкує `RUN_ID`. Cleanup тільки цього прогону:

```bash
node -r ../dev-use-test-db.js scripts/liveOrderPickingE2ECleanup.js --runId=<RUN_ID> --execute
```

`--keep-on-failure` можна додати до ручного запуску, якщо треба залишити synthetic fixtures у тестовій БД для огляду після падіння.

## v36.4 addition — final summary retention

`test:live:contracts` now also runs `final_summary_retention`: it completes a synthetic session, verifies `OrderingSession.finalSummary`, deletes only that synthetic session's completed `PickingTask` rows (simulating retention), then calls the real `queue-stats` HTTP endpoint and verifies that phase/counters remain `completed` and unchanged.
