# Повна історія продавця, 90-денний picking retention і захист зовнішніх дій

Дата: 2026-08-06

## Зміни

### Історія продавця

- `GET /api/v1/orders` лишився серверно пагінованим по 200 записів.
- `GET /api/supplement/admin/seller/:telegramId` отримав `page`, `pageSize`, `total`, `pageCount`.
- клієнт адмінської історії послідовно довантажує всі серверні сторінки звичайних замовлень і дозамовлень;
- локальна пагінація по 5 днях тепер ділить повну історію, а не перші 200/500 записів.

### Picking retention

- application sweep змінено з 30 на 90 днів;
- правило узгоджено з `completedExpireAt` та TTL-індексом `PickingTask`.

### Захист endpoint-ів

- `/api/openai-status` і `/api/gemini-status` більше не public, доступні лише адміну;
- `/api/search-products/resend` вимагає авторизованого користувача з роллю seller/admin/warehouse;
- `/api/v1/products/report-missing` більше не public і додатково має role gate seller/admin/warehouse;
- read-only barcode lookup лишився public, бо використовується окремою сторінкою публічного сканера;
- публічний сканер більше не намагається виконувати resend/report без Telegram або browser-сесії;
- image redirect лишився public, бо `<img>` не може додати Telegram initData header.

## Не змінено

- бізнес-логіку перенесення продавця;
- preload/decode фотографій каталогу;
- правила дозамовлення;
- публічний read-only сканер.
