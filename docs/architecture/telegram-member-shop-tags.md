# Telegram member shop tags — all configured bot groups

## Contract

`telegram.allowedGroupIds` is the complete managed group set. There is no MAIN group and list order has no identity meaning.

For every active ERP user with a stable `telegramId`, and independently for every configured group:

- Telegram `member` + ERP shop -> `#${shop.name}` (max 16 Unicode code points including `#`)
- Telegram `member` + no shop / removed ERP user -> empty tag
- Telegram `administrator` -> DO NOT TOUCH
- Telegram `creator` -> DO NOT TOUCH
- other Telegram statuses -> no write
- desired tag already equals actual tag -> NOOP

ERP `User -> Shop -> shop.name` is authoritative. Username, names, existing tag text and Telegram profile data are never used to infer a shop.

## Group lifecycle

`POST /api/admin/telegram-groups` persists the configured group independently of transient Telegram availability/permissions, immediately enqueues all ERP Telegram users for that group, and returns a best-effort live health result. If `can_manage_tags` is missing, the group remains configured and its queue waits/rechecks safely until permission is granted.

`DELETE /api/admin/telegram-groups/:groupId` removes the group from the managed set. Before removal it schedules ownership-safe cleanup only for tags that this subsystem previously observed as its own. Admin/creator titles and manually changed tags are never cleared.

An existing DB value `telegram.allowedGroupIds=[]` is authoritative. The legacy `TELEGRAM_ALLOWED_GROUP_IDS` environment variable is used only when the DB setting does not exist, so deleting all groups cannot silently resurrect env groups.

## Durable projection queue

Queue identity is `(telegramId, chatId)`, not only user. This is required because the same user can be a regular member in one group, an admin in a second group and absent from a third.

Each target has independent status/retry/revision state. A failure in one group therefore cannot block convergence in another group.

Normal sync re-reads current User and Shop state at execution time. Queue rows do not own business truth.

The worker has:

- revision guard against stale worker completion;
- 2-minute processing lease recovery;
- bounded retries;
- per-group health preflight;
- one-minute backoff for groups missing infrastructure/permissions so N users do not create N identical Telegram failures;
- a dedicated scheduler leader separate from Telegram delivery.

## Telegram transport

The project keeps the existing `node-telegram-bot-api ^0.67.0` runtime. GitHub documents a later `0.68.0`, but npm does not publish that version, so production must not depend on it.

`node-telegram-bot-api@0.67.0` already has one generic internal `_request(path, options)` transport used by all public methods. `services/telegramMemberTagTransport.js` is the single compatibility boundary for the new Bot API method and calls:

`bot._request('setChatMemberTag', { form: { chat_id, user_id, tag } })`

This reuses the bot instance's existing timeout, base API URL/proxy behavior and Telegram error shape, and avoids a second HTTP implementation or a risky whole-library migration. The adapter fails closed if `_request` is ever unavailable, so a future Telegram SDK migration is localized to one file.

## Invalidation sources

- canonical user -> shop assignment transition -> all configured groups for that user;
- shop name change -> all users in the shop x all configured groups;
- `chat_member` update -> exact changed user + exact configured group;
- `new_chat_members` service update -> exact user + exact configured group;
- bot regains `can_manage_tags` -> reconcile exact configured group;
- group added -> all ERP Telegram users for exact new group;
- manual reconcile -> all ERP Telegram users x all configured groups.

No Telegram member-directory scan is used.

## Admin API / UI

- `GET /api/admin/telegram-groups` -> configured groups
- `POST /api/admin/telegram-groups` -> validate + add + enqueue group reconcile
- `DELETE /api/admin/telegram-groups/:groupId` -> remove + ownership-safe cleanup queue
- `GET /api/admin/telegram-member-tags` -> per-group live health, queue counts, recent events
- `POST /api/admin/telegram-member-tags/reconcile` -> enqueue all users across all configured groups

The Settings UI has no MAIN selector. The normal "Групи бота" add/remove list is the configuration surface; the "Плашки магазинів" card is diagnostics/reconcile only.
