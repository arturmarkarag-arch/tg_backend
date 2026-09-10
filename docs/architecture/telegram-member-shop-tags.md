# Telegram member shop tags — dedicated group setting

## Separation of concerns

Shop member tags are a separate Telegram feature with their own DB-only group list:

- bot-authorized groups: `telegram.allowedGroupIds`
- shop member-tag groups: `telegram.memberTagGroupIds`

These lists are intentionally independent. Adding/removing a group in **Групи бота** does not enable/disable shop tags. Adding/removing a group in **Плашки магазинів** does not authorize bot replies, registration membership, announcements, or other bot-group behavior.

There is no MAIN group and there is no runtime fallback from the member-tag list to `telegram.allowedGroupIds` or `TELEGRAM_ALLOWED_GROUP_IDS`.

## Tag contract

For every active ERP user with a stable `telegramId`, and independently for every group configured under `telegram.memberTagGroupIds`:

- Telegram `member` + ERP shop -> `#${shop.name}` (max 16 Unicode code points including `#`)
- Telegram `member` + no shop / removed ERP user -> empty tag
- Telegram `administrator` -> DO NOT TOUCH
- Telegram `creator` -> DO NOT TOUCH
- other Telegram statuses -> no write
- desired tag already equals actual tag -> NOOP

ERP `User -> Shop -> shop.name` is authoritative. Username, names, existing tag text and Telegram profile data are never used to infer a shop.

## Member-tag group lifecycle

`GET /api/admin/telegram-member-tag-groups` returns only the dedicated member-tag destinations.

`POST /api/admin/telegram-member-tag-groups` persists the new member-tag group and enqueues all ERP Telegram users only for that group. A transient Telegram permission/network problem does not corrupt configuration; live health is returned separately and the worker waits until the bot has `can_manage_tags`.

`DELETE /api/admin/telegram-member-tag-groups/:groupId` removes only the member-tag destination. Before removal it schedules ownership-safe cleanup only for tags that this subsystem previously observed as its own. Admin/creator titles and manually changed tags are never cleared.

The normal `/api/admin/telegram-groups` CRUD is restored to its original bot-group behavior and has no member-tag side effects.

## Durable projection queue

Queue identity is `(telegramId, chatId)`. Each member-tag group has independent retry/revision state, so one blocked group cannot block another.

Normal sync re-reads current User and Shop state at execution time. Queue rows do not own business truth.

The worker has:

- revision guard against stale worker completion;
- 2-minute processing lease recovery;
- bounded retries;
- per-group health preflight;
- per-group flood-control cooldown;
- a dedicated scheduler leader separate from Telegram delivery.

Rows created by the old V3/V4 coupling are not trusted after the settings split. Ordinary sync rows whose `chatId` is not currently in `telegram.memberTagGroupIds` are retired as `skipped_group_removed` without a Telegram write. Explicit cleanup rows remain eligible because they intentionally target a just-removed member-tag group.

## Telegram transport

The project keeps the existing `node-telegram-bot-api ^0.67.0` runtime.

`services/telegramMemberTagTransport.js` is the isolated compatibility boundary for the Bot API method and calls:

`bot._request('setChatMemberTag', { form: { chat_id, user_id, tag } })`

The adapter reuses the bot instance's existing transport and fails closed if `_request` becomes unavailable.

## Invalidation sources

- canonical user -> shop assignment transition -> all configured **member-tag** groups for that user;
- shop name change -> all users in the shop x all configured **member-tag** groups;
- `chat_member` update -> exact changed user + exact member-tag group, even when that chat is not in `telegram.allowedGroupIds`;
- bot regains `can_manage_tags` -> reconcile exact member-tag group;
- member-tag group added -> all ERP Telegram users for exact new group;
- manual reconcile -> all ERP Telegram users x all configured member-tag groups.

No Telegram member-directory scan is used.

## Admin API / UI

Bot groups remain independent:

- `GET /api/admin/telegram-groups`
- `POST /api/admin/telegram-groups`
- `DELETE /api/admin/telegram-groups/:groupId`

Shop tag groups use their own CRUD:

- `GET /api/admin/telegram-member-tag-groups`
- `POST /api/admin/telegram-member-tag-groups`
- `DELETE /api/admin/telegram-member-tag-groups/:groupId`
- `GET /api/admin/telegram-member-tags` -> per-group live health, current queue counts, recent events
- `POST /api/admin/telegram-member-tags/reconcile` -> enqueue all ERP users across only the dedicated member-tag groups

The Settings UI therefore has two independent editors: **Групи бота** and **Плашки магазинів**.

## Flood control / 429

`setChatMemberTag` writes are paced independently per member-tag group. The default write interval is 3500 ms and can be changed operationally with `TELEGRAM_MEMBER_TAG_WRITE_INTERVAL_MS` (minimum 500 ms).

A Telegram 429 is treated as a group-level flood-control condition. The worker reads `parameters.retry_after`, adds a safety buffer, defers every pending/retry target for that member-tag group, and aligns the in-process write gate with the same deadline. If Telegram does not provide `retry_after`, the fallback cooldown is 60 seconds.

New event syncs and manual reconcile preserve an active group cooldown instead of resetting `nextAttemptAt` to now.
