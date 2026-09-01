# Telegram `MESSAGE_ID_INVALID` recovery

## Problem

Telegram can answer an edit/probe with the symbolic error:

`Bad Request: MESSAGE_ID_INVALID`

Older lifecycle code only recognized the textual `message to edit not found` form. The symbolic form was therefore persisted as generic `failed`. Because the old `chatId/messageId` stayed attached, pressing Retry queued another update against the same invalid message and could loop forever.

## Fixed contract

- `MESSAGE_ID_INVALID` is normalized to internal `message_not_found`.
- Future update/probe failures with that error transition the publication to `missing`.
- Existing persisted `failed + MESSAGE_ID_INVALID + chatId/messageId` rows are normalized to `missing` on read and on publish decision; no Mongo migration is required.
- The recovery action for a normalized missing publication clears the stale `messageId` and queues a create (`sendPhoto`) instead of another edit.
- Receipt/gallery API projections now include the Telegram reference needed to normalize legacy rows consistently.
- Client recovery UI also recognizes legacy raw rows defensively and renders the missing-post recovery action immediately.
- Related symbolic Telegram descriptions (`MESSAGE_NOT_MODIFIED`, `MESSAGE_EDIT_TIME_EXPIRED`, `CHAT_ID_INVALID`) are normalized into the existing semantic policy.

## Expected UI flow

1. Post is manually deleted in Telegram.
2. Verify/edit receives `Bad Request: MESSAGE_ID_INVALID`.
3. UI shows `Telegram · Пост видалено`.
4. User presses `Надіслати пост повторно` once.
5. Server clears the stale Telegram message reference and queues a fresh create.
6. Worker uses `sendPhoto`; on success the new `messageId` is persisted and status returns to `sent`.
