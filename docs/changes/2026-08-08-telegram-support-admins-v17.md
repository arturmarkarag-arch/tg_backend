# v17 — Telegram support admins for registration

## Зміни
- Додано `telegram.supportAdmins` у `AppSetting` як список `{name, username}`.
- Адмінські API дозволяють додавати/видаляти контакти для реєстраційної підтримки.
- `/start` для незареєстрованої людини поза групою «Оголошення» показує налаштовані імена та прямі `t.me`-кнопки для чату.
- Якщо людина є в «Оголошення», бот видає персональний registration token і одну кнопку `Відкрити` у Mini App.
- Та сама допомога застосована до shop-invite та інших private bot entry points.
- `registration-invite` та `registration_not_in_group` повертають публічний список support-admins, щоб Mini App також міг показати прямі контакти.

## Безпека
- Налаштування змінює тільки роль `admin`.
- Telegram username нормалізується та валідовується; HTML-імʼя екранується перед вставкою в Telegram message.
- Посилання генерується сервером лише як `https://t.me/<validated_username>`.
- Registration gate не послаблено: `getChatMember` / allowed-group membership як і раніше обовʼязковий.
