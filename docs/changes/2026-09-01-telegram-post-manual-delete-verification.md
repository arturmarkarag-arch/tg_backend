# Telegram «Нові Товари»: перевірка ручного видалення поста

Дата: 2026-09-01

## Проблема

Bot API не надсилає звичайний update про ручне видалення channel post і не має read-only `getMessage(chat_id, message_id)`. Через це `ReceiptItem.telegramNewProduct.status = sent` міг залишатися назавжди, доки наступне редагування товару випадково не викликало `editMessageCaption/editMessageMedia`.

## Рішення

Доданий окремий staff-only endpoint:

`POST /receipts/:id/items/:itemId/telegram-new-product/verify`

Перевірка виконується під тим самим per-item lock, що publication/delete/unconfirm. Для підтвердженого `sent`-поста сервер робить no-op `editMessageCaption` з canonical applied caption:

- `message is not modified` -> пост існує;
- успішний edit -> пост існує, а ручна зміна caption повернена до canonical стану;
- `message to edit not found` -> publication переводиться в `missing` через існуючий lifecycle handler;
- timeout/429/permissions/chat errors не переводять живий пост у `missing` і не псують publication state.

## UI

`ReceiptPhotoPreparationPanel`:

- перевіряє `sent`-пост один раз при відкритті позиції;
- повторює перевірку при поверненні фокусу/visibility у Mini App;
- має явну кнопку `Перевірити` для `sent`-поста;
- після `missing` інвалідує receipt item caches, тому на картці з'являється існуюча дія `Надіслати пост повторно`.

Є 5-секундний local throttle, щоб focus + visibilitychange не породжували подвійні Bot API запити.

## Свідоме обмеження

Це active verification, а не webhook. Миттєво дізнатися про ручне видалення звичайного channel post через Bot API неможливо. Стан стає `missing`, коли працівник відкриває позицію/повертається в Mini App або натискає `Перевірити`.
