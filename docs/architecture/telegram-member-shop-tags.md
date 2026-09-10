# Telegram member shop tags — architecture contract

Date: 2026-09-10

## Purpose

Project the canonical ERP relation `User.shopId -> Shop.name` into the one explicitly configured MAIN Telegram work group as a regular-member tag:

`#` + `Shop.name`, NFC-normalized and truncated to 16 Unicode code points including `#`.

This is a projection only. Telegram is never the source of shop assignment truth.

## Hard boundaries

- MAIN group identity is `AppSetting('telegram.mainGroupId')`.
- `telegram.allowedGroupIds` remains the authorization list and is not used as an ordered source of MAIN identity.
- User identity is the existing stable `User.telegramId`; usernames/names are never matched.
- Only `ChatMember.status === 'member'` is managed.
- `administrator` and `creator` are always `SKIP` and no write is attempted.
- Restricted users are outside this initial contract and are skipped explicitly.
- `setChatAdministratorCustomTitle` is never part of this subsystem.
- Other groups, channels, delivery groups and the “Нові товари” destination are never tag targets.

## Desired-state calculation

Every worker attempt re-reads current Mongo state:

1. `User.findOne({ telegramId })`
2. if `user.shopId`, `Shop.findById(user.shopId)`
3. desired tag = `formatTelegramMemberTag(shop.name)` or `''`

The outbox does not store an authoritative desired tag. Diagnostic snapshots are write-only history and are never fed back into decisions.

If a shop name contains emoji, the projection is marked `invalid_tag` instead of silently rewriting the business name. Telegram does not allow emoji in member tags.

## Invalidation sources

A user is dirtied after commit when:

- canonical shop assignment/unassignment changes (`publishShopAssignmentTransition`);
- a Shop name changes (`updateShopTopologyCommand`, queues every currently assigned user);
- Telegram emits `chat_member` for that user in MAIN;
- a basic-group `new_chat_members` service message is observed in MAIN;
- MAIN is configured/changed;
- the bot itself regains tag-management rights in MAIN;
- an administrator starts manual reconcile.

This keeps the mutation path fast: ERP writes do not wait for Telegram network I/O.

## Durable outbox

`TelegramMemberTagSync` is one dirty-marker row per Telegram user.

- `requestedRevision` increments for every invalidation.
- the worker snapshots the claimed revision.
- completion is conditional on the same revision, so an older in-flight attempt cannot overwrite a newer dirty request.
- each processing row has a 2-minute lease; a process crash leaves a row recoverable by a later scheduler tick.
- retryable Telegram/network failures use bounded backoff, with 8 automatic attempts maximum.
- a new invalidation or manual reconcile resets attempts to 0.
- one failed row is isolated and never aborts the rest of a reconcile batch.

A dedicated `telegram-member-tags` scheduler leader drains this outbox every 5 seconds. It uses the existing distributed scheduler-leader infrastructure, but it is deliberately separate from `telegram-delivery` so a reconcile batch cannot delay Telegram notifications or new-product delivery.

## Telegram decision

For each attempt:

1. `getChatMember(MAIN, telegramId)`
2. `administrator` -> `skipped_admin`
3. `creator` -> `skipped_creator`
4. `left` / `kicked` / participant absent -> `not_in_group`
5. anything other than `member` -> explicit skip
6. `member.tag === desiredTag` -> `unchanged` and no Telegram write
7. otherwise `setChatMemberTag(MAIN, telegramId, { tag: desiredTag })`

An empty desired tag clears the tag.

If the user becomes administrator between read and write and Telegram rejects the write, status is re-read once; admin/creator is converted to a safe skip.


## MAIN-group migration

If MAIN changes from group A to B, the normal reconcile targets only B. Before writing B, the worker also performs a best-effort cleanup of the previous MAIN recorded in its diagnostic snapshot, with an ownership guard:

- admin/creator in the old group -> never touch;
- non-member/restricted -> skip;
- clear only when the current old-group tag still exactly equals the last non-empty tag managed/observed by this ERP projection;
- if the tag has been changed manually, leave it untouched;
- cleanup failure is journalled but does not block convergence in the new MAIN group.

This prevents the common stale-tag case without granting the subsystem authority over unrelated/manual Telegram tags.

## Recovery and diagnostics

Admin API:

- `GET /api/admin/telegram-groups` -> allowed groups + explicit `mainGroupId`
- `PUT /api/admin/telegram-groups/main` -> choose MAIN and enqueue reconcile
- `GET /api/admin/telegram-member-tags` -> live bot/group permission health + queue counts + recent events
- `POST /api/admin/telegram-member-tags/reconcile` -> enqueue all ERP users with Telegram IDs

Health checks the configured chat, bot membership and the exact `can_manage_tags === true` permission. It never infers this capability from `can_pin_messages`; missing/false `can_manage_tags` is a fail-closed diagnostic state.

Structured events are persisted in `TelegramMemberTagSyncEvent` with operational-history TTL and also emitted as `[telegram-member-tag-sync]` JSON logs. Bot token is never included.

## Dependency contract

This project intentionally pins `node-telegram-bot-api` to `0.68.0`: it is the first legacy CommonJS-compatible release used here that contains `setChatMemberTag`. Do not upgrade this feature opportunistically to v2; v2 has a different public API surface and requires a separate migration project.
