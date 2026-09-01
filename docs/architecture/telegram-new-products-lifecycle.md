# Telegram «Нові Товари» — доменна архітектура lifecycle

**Baseline:** 2026-09-01 final hardening gate

## 1. Головний контракт

`ReceiptItem` — єдине джерело бізнес-даних про прийнятий товар. Telegram не є джерелом істини і ніколи не має відкочувати успішне збереження, редагування, confirm/unconfirm або дозволене safe-mode видалення.

Водночас Telegram-публікація — вже окрема доменна сутність, а не набір випадкових полів у `ReceiptItem`. Один `ReceiptItem` має одну логічну `TelegramPublication`, але протягом життя вона може мати кілька фізичних Telegram-повідомлень (`TelegramPublicationBinding`). Це необхідно для коректної роботи з `unknown`, повторною публікацією, зміною групи, дублями та cleanup.

Embedded `ReceiptItem.telegramNewProduct` залишено лише як **legacy migration input / compatibility history**. Runtime lifecycle не пише туди новий стан.

## 2. Модель даних

### `TelegramDestination`

Поточна конфігурація каналу «Нові Товари»:

- `chatId`;
- `enabled`;
- `configRevision`;
- title/type;
- bot membership/permissions;
- `healthCode` / `healthDescription`;
- timestamps зміни та health-check.

Зміна destination не переписує історичні physical bindings. Пост, створений у старій групі, назавжди зберігає свій фактичний `chatId`.

### `TelegramPublication`

Одна логічна публікація одного `ReceiptItem`:

- `sourceId`, `receiptId`;
- `sourceState`: `draft | confirmed | deleted`;
- lifecycle `status`;
- desired/applied payload + hash;
- current/sending binding references;
- generation counter;
- retry/lease metadata;
- operator decision metadata;
- `unresolvedBindingCount` — усі unresolved bindings;
- `ambiguousBindingCount` — лише bindings, для яких Telegram-пост **може існувати, але `messageId` невідомий**;
- `possibleDuplicate` — тільки наслідок реальної no-message ambiguity, а не будь-якого `manual_required`.

### `TelegramPublicationBinding`

Один фізичний Telegram message-generation:

- `publicationId`;
- `generation`;
- точний `chatId`;
- `messageId`, якщо відомий;
- state: `creating | live | unknown | missing | deleted | manual_required | resolved | superseded`;
- payload hash/snapshot/caption;
- Telegram `file_id`;
- create/confirm/edit/verify timestamps;
- access/permission state;
- resolution metadata.

**Binding не перезаписується новою generation.** Якщо create №1 став `unknown`, а оператор зробив create №2, generation №1 лишається окремим unresolved binding до reconciliation.

### `TelegramPublicationEvent`

Append-only аудит доменних переходів. Фіксує:

- create/update/verify/missing;
- destination changes;
- chat migration;
- membership changes;
- cleanup/reconciliation;
- actor;
- `chatId/messageId/generation/payloadHash`;
- from/to state та details.

### `TelegramMessageCleanup`

Durable cleanup obligation. Підтримує:

- exact cleanup (`chatId + messageId`);
- ambiguous cleanup (create міг пройти, але `messageId` невідомий);
- retry/backoff;
- `manual_required`;
- manual resolution;
- conversion ambiguous → exact, якщо оператор знайшов пост.

## 3. Canonical payload

Telegram hash формується з бізнес-значущих даних:

- original photo URL;
- price;
- qty per pack;
- comments;
- повного canonical route signature:
  - `warehouse`;
  - `mandatory`;
  - `supplement`;
  - `mayNotReachAllShops`;
  - `supplementDeliveryGroupId`.

Canvas-only рух підписів/візуальних елементів не входить у hash.

Це означає, що навіть якщо короткий видимий route label випадково не змінився, зміна реального бізнес-маршруту все одно створює новий desired hash.

## 4. Lifecycle публікації

Основні стани `TelegramPublication`:

- `not_sent` — фізичного поста ще немає;
- `queued` — є durable intent на create/update;
- `sending` — конкретний Bot API attempt у роботі;
- `retry_wait` — безпечний retry після однозначно retryable помилки;
- `sent` — current live binding містить applied payload;
- `failed` — однозначна terminal failure;
- `unknown` — create міг бути прийнятий Telegram, але сервер не отримав доказ/`messageId`;
- `missing` — відомий current post більше не існує;
- `retired` — source draft/deleted, активна публікація більше не повинна існувати.

### Create

1. User/API рішення `publish` виконується під per-item lifecycle lock.
2. Сервер повторно читає `ReceiptItem` і вимагає `status=confirmed`.
3. Перевіряються cleanup/reconciliation blockers.
4. Desired payload зберігається в `TelegramPublication` як `queued`.
5. Worker atomic claim переводить publication у `sending`.
6. Перед Bot API worker **ще раз** читає authoritative `ReceiptItem`.
7. Для нового create Binding + publication link створюються в одній Mongo transaction.
8. `sendPhoto` виконується з bounded request timeout.
9. Success атомарно переводить Binding у `live`, Publication у `sent` або `queued`, якщо desired payload встиг змінитися під час send.

### Update

Known live binding редагується за своїм фактичним `chatId/messageId`, навіть якщо configured destination пізніше змінився. Caption/media update retryable, бо physical target відомий.

### Missing

`message to edit not found` і Telegram symbolic `MESSAGE_ID_INVALID` нормалізуються в `message_not_found`.

Binding → `missing`, Publication → `missing`. UI відразу показує **«Надіслати пост повторно»** незалежно від стану кнопки `Зберегти` для товару.

Active verify робиться при відкритті/поверненні у UI та вручну. Bot API не має звичайного delete webhook/getMessage для channel post, тому detection не може бути миттєвим без probe.

## 5. `unknown` — окрема невизначеність, а не error string

Create через timeout/reset/5xx може мати дві реальності:

- Telegram нічого не створив;
- Telegram створив пост, але response не дійшов.

Тому create **не retry-иться автоматично** як звичайний update.

Створюється/зберігається `unknown` Binding без `messageId`. Це durable evidence можливої фізичної публікації.

Operator recovery:

1. **«Посту немає»** → binding `resolved`, поточна publication може знову стати `not_sent`.
2. **«Пост існує»** → оператор вводить `chatId/messageId`, сервер verify-ить його і:
   - якщо це current unknown — відновлює його як live current binding;
   - якщо це historical unknown — переводить його в exact duplicate cleanup.
3. **Свідомий force retry current unknown** дозволений лише для цієї current ambiguity. Будь-яка старіша unresolved ambiguous generation все одно блокує наступний physical create.

`possibleDuplicate=true` означає лише реальну no-message ambiguity. Exact known message з cleanup-проблемою не називається “можливим дублікатом”.

## 6. Блокування нових physical generations

Новий create заборонений, якщо для цієї publication є:

- open `TelegramMessageCleanup`; або
- historical `unknown/manual_required` Binding без `messageId`.

Known live update при цьому не блокується: стара історична cleanup-проблема не повинна заморожувати синхронізацію вже відомого current post.

Цей контракт запобігає накопиченню generation №3, №4, №5 поверх невирішеної generation №1.

## 7. DELETE / unconfirm / safe mode

Telegram не входить у business usage guard. Safe-mode залишається головним:

- якщо ReceiptItem/Product уже використовується Block/Order/Picking/Supplement lifecycle → `409`, нічого не видаляється;
- якщо destructive action дозволений → cleanup obligations створюються **в тій самій Mongo transaction**, що й source delete/unconfirm/retire.

Cleanup збирає всі релевантні Binding generations:

- live/known → exact cleanup;
- unknown без `messageId` → `manual_required` ambiguous cleanup;
- in-flight `creating` під час create ambiguity → також fail-closed ambiguous cleanup.

Тому committed source delete не може мовчки стерти доказ можливої Telegram-публікації.

Якщо Bot API create завершується успіхом **після** source retire, late success не воскресить Publication. Відомий `messageId` перетворюється на exact cleanup obligation.

## 8. Concurrency / crash consistency

### Per-item lock

Publish decision, worker send, DELETE і unconfirm використовують один key:

`telegram:new-product:item:<itemId>`

`recordDecision()` не довіряє pre-route check — authoritative `ReceiptItem` читається повторно всередині lock.

### Transport timeout

Telegram request timeout: **45 s**.

Per-item lock TTL: **120 s**.

Це не є математичним доказом, що Telegram не завершить уже прийнятий create після client timeout. Саме тому create timeout все одно переходить у `unknown`; timeout лише не дозволяє локальному HTTP request безмежно пережити lock.

### Global delivery lane

Delivery lane TTL: **10 min**.

Batch budget: **8 min**, плюс один bounded request < lane TTL. Worker перевіряє pause між елементами batch.

### Crash після physical create

Якщо процес впав після/під час create без persisted response, expired `sending=create` recovery переходить fail-closed у `unknown`, а не в blind retry.

Known update після expired lease можна безпечно retry-ити.

## 9. Failure atomicity

Binding state + Publication state + Event для `message_not_found`, ambiguous create і звичайної failure/retry transition записуються в одній Mongo transaction.

Це важливо для safe semantic rejection, наприклад 429: crash між двома незалежними записами не повинен перетворити однозначно невідправлений create на фальшивий `unknown`.

`migrate_to_chat_id` має окрему атомарну migration transaction, після якої delivery state переводиться в retryable transition.

## 10. Destination lifecycle

### Save / change / clear

- ID нормалізується.
- Непорожній ID перевіряється через `getChat/getMe/getChatMember`.
- Destination config + legacy mirror + safe retarget unsent creates + Event записуються transactionally.
- `configRevision` дозволяє бачити, до якої конфігурації належала generation.

### Existing posts

Вже створений Binding не “переїжджає” при зміні Settings. Він лишається прив’язаним до свого historical chat і редагується там.

### Pause

Порожній destination ID — повна пауза delivery lane. Worker повторно перевіряє switch між кожним batch item.

### Health

Current destination health і historical binding access — різні речі.

- `my_chat_member` оновлює current Destination, якщо подія про configured chat;
- та окремо всі live/unknown/manual/creating Bindings у цьому historical chat.

Реальні delivery errors (`unauthorized`, `forbidden`, `chat_not_found`) також оновлюють відповідний Destination/Binding health, тому система не залежить лише від webhook.

Для власних outgoing channel posts право публікації достатнє для штатного `deleteMessage`; `can_delete_messages` потрібне для ширшого видалення і не використовується як фальшивий blocker власного cleanup.

## 11. Photo recovery

Після першого success зберігається Telegram `file_id`.

Якщо cached `file_id` стає невалідним, worker один раз відкидає cache та повторює через canonical `originalPhotoUrl`, замість циклічного retry тим самим мертвим `file_id`.

Поточна версія `node-telegram-bot-api` усе ще покладається на Telegram fetch canonical URL для деяких media-edit flows. Якщо сам original URL недоступний, операція fail-иться actionably і потребує повторного завантаження фото. Це відома platform/library limitation, не прихований success.

## 12. UI contract

Кнопка **`Зберегти`** належить тільки ReceiptItem form state.

Telegram lifecycle actions не залежать від dirty state форми:

- `not_sent/publish` → **Опублікувати в Telegram**;
- stale payload → **Оновити Telegram**;
- `missing` → **Надіслати пост повторно**;
- `failed` → **Повторити Telegram-відправку**;
- `unknown` → **Створити новий пост** або **Пост існує — прив’язати messageId**;
- historical ambiguity → пояснення, що спочатку потрібен reconciliation у Settings;
- cleanup pending → пояснення cleanup blocker.

Якщо create/recreate неможливий через disabled destination, missing photo або binding access, UI показує конкретну причину замість активної кнопки, яка гарантовано впаде.

## 13. Legacy migration

Startup migration:

1. переносить embedded legacy rows у Publication/Bindings/Events transactionally;
2. repair-ить partial migration старішої версії;
3. `sending + messageId` мігрує як retryable known update;
4. `sending + без messageId` мігрує як `unknown` create ambiguity;
5. для ledger-документів першого rollout, де ще не було `ambiguousBindingCount`, counters одноразово перераховуються з physical Bindings.

Після міграції embedded поля не є runtime source of truth.

## 14. Мінімальний release gate

```bash
cd server
node scripts/checkTelegramNewProductsArchitecture20260901.js
node --check services/receiptNewProductTelegram.js
node --check services/telegramMessageCleanup.js

cd ../client
node scripts/checkTelegramNewProductsUi20260901.mjs
```

Повний release environment додатково має прогнати Vitest/build з установленими dependencies.
