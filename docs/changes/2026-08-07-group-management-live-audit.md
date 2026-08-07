# 2026-08-07 — Управління → Групи: live Telegram audit

## Зроблено
- Додано notification-free live перевірку одного учасника через `getChatMember`.
- Додано масову кнопку/endpoint `Перевірити групу` з послідовними Telegram-запитами та паузою між ними.
- Помилки Telegram API (`403/429/network/5xx`) зберігаються як `unknown` і не трактуються як вихід.
- `left`, `kicked`, `restricted`, `member`, `administrator`, `creator`, `not_found`, `unknown` зберігаються окремо.
- У `GroupMember` додано `telegramStatus`, `statusCheckedAt`, `statusCheckError`.
- Масова перевірка охоплює відомих учасників групи + всіх зареєстрованих seller-користувачів, щоб бачити випадок «є в додатку, але немає в групі».
- Старий admin `/recheck` більше не робить re-push welcome/registration повідомлення; він лише перевіряє статус.
- Додано `User.lastAppOpenedAt`; він оновлюється при bootstrap профілю Mini App / browser session.
- Admin group list повертає останню активність у додатку та магазин користувача як контекст.
- Оновлено nav badge: він не рахує вже відсутніх незареєстрованих як актуальну проблему.
- Додано unit-тест `tests/groupMemberAudit.test.js` для present/absent/unknown семантики.

## Важливі правила
- Жодна перевірка на сторінці «Групи» не надсилає повідомлень користувачам.
- `unknown` ніколи не змінює `left`.
- Admin/warehouse не синтезуються як «відсутні в групі» лише через те, що вони є в додатку; така звірка обов'язкова саме для seller. Якщо admin/warehouse реально бачилися в Telegram-групі, їхній GroupMember все одно показується та перевіряється.

## Перевірки
- `node -c` пройдено для всіх змінених server JS файлів.
- JSX/JS client файли розібрані TypeScript parser без parse diagnostics.
- Повний `npm test` / `vite build` локально не запущено: у робочому контейнері залежності не були встановлені, а `npm ci` зупинився на відсутньому пакеті `yocto-queue@1.2.2` у внутрішньому npm registry.
