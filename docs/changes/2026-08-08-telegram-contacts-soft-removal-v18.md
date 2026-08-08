# 2026-08-08 — Telegram contacts + soft account removal (v18)

## Added
- Reusable Telegram contact button: username first, `tg://user?id=...` fallback.
- Contact shortcut added to staff-facing people views: group monitor, users, shop sellers, picking/shop alerts/conflicts, registration requests, shift board.
- `Видалити` action in Telegram group-member monitor.

## Removal semantics
- No `User` or `GroupMember` row is physically deleted.
- Existing account becomes `accountState=removed`, receives `removedAt/removedByTelegramId`, browser sessions are revoked, open sockets are disconnected.
- User is detached from operational ownership; seller/admin shop assignment is cleared through the canonical unassign flow and warehouse locks are released.
- GroupMember rows are hidden from live group lists/audits/badges but remain as history.
- Active user lists and warehouse/group recipient lists exclude `accountState=removed`.

## Re-registration
A removed identity is treated as not registered for authentication and bot `/start`.
It may register again only through the normal gates: live membership in the allowed Telegram group, valid registration token, required form/shop checks and (for warehouse) admin approval.
Successful registration reactivates the same User row, clears GroupMember hidden flags and records `account_reregistered` in User history.
For sellers, any parked active order is reattached using `migrateSellerShop` rather than by a raw shopId write.

## Security/correctness checks
- Removed users rejected by HTTP auth and Socket.IO auth.
- Custom POST `/orders` path explicitly rejects removed accounts (it bypasses common telegramAuth by design).
- Removed/former admins cannot use stale Telegram inline approval buttons.
- Existing sockets receive `account_removed`, browser token is cleared and the server disconnects the per-user room.
