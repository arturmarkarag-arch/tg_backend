# Shop switch / ordering-session false transition fix

## Problem
Switching an admin/warehouse user between shops in different delivery groups could briefly pair the new `shopId` with the previous group's `orderingSessionId`. `MiniAppPage` treated any session-id mismatch as a brand-new ordering session, reset navigation, and displayed `Почалася нова сесія замовлень. Відкрито перший товар.` even when the target group was closed.

## Fix
- `PATCH /api/v1/telegram/me/shop` now returns the target shop's `orderingSessionId` and full `orderingStatus` in the same response as the assignment change.
- The client resolves that ordering context before applying the new shop and batches shop/session/status into one client context.
- The proactive "new ordering session" toast is seller-only and requires authoritative `orderingStatus.isOpen === true`.
- `ordering_session_changed` 409 recovery no longer claims that ordering opened; sellers get a neutral synchronization notice. Admins receive no session toast.

## Semantics
The toast is purely local UI feedback. It is not an administrative notification, Telegram message, or audit event.
