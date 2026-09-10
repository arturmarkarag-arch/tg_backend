Telegram member shop tags — V3 multi-group fix (2026-09-10)
==========================================================

This V3 patch supersedes V1/V2 member-tag patches.
Apply backend files over the current backend and frontend files over the current frontend.

IMPORTANT CHANGES FROM V2
- MAIN group concept removed completely.
- Every group added in Settings -> "Групи бота" is a shop-tag target.
- Queue identity is telegramId + chatId, so group failures/retries are independent.
- Adding a group persists normally, returns live permission health, and queues all ERP users for that group; missing can_manage_tags does not block configuration.
- Removing a group schedules ownership-safe cleanup of ERP-managed tags.
- node-telegram-bot-api remains ^0.67.0. DO NOT install 0.68.0.
- setChatMemberTag is called through a tiny compatibility adapter over the existing SDK generic _request transport.

LOCAL
Backend:
  npm install
  npm run test:telegram-member-tags

Frontend:
  npm install
  npm run test:telegram-member-tags
  npm run build

Do NOT run:
  npm install node-telegram-bot-api@0.68.0

PRODUCTION
Deploy both backend and frontend from this V3 patch.
The bot must be administrator with can_manage_tags=true in EACH configured bot group.

UI
Settings -> Telegram -> Групи бота
Add the group ID normally. There is no MAIN selector.
After adding, the server queues tag sync automatically and shows Telegram/can_manage_tags health; missing permission can be granted later.
"Плашки магазинів" shows per-group health and has a manual "Синхронізувати всіх" recovery action.


V4 flood-control hardening
---------------------------
- setChatMemberTag writes are paced per group (default 3500 ms).
- Telegram 429 + retry_after pauses the whole affected group, not just one user.
- Manual reconcile and event-driven sync cannot bypass an active 429 cooldown.
- Optional ops override: TELEGRAM_MEMBER_TAG_WRITE_INTERVAL_MS (min 500 ms).
