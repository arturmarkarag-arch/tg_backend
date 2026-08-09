# 2026-08-09 — v24 per-group ordering schedule

- Перенесено weekly ordering schedule з глобального AppSetting у DeliveryGroup.
- Додано explicit start/end weekday/hour/quarter-minute.
- Видалено runtime Monday/Sunday special-case; він лишився тільки в one-time migration compatibility helper.
- `dayOfWeek` лишився фізичним днем доставки.
- Збережено session identity `{groupId, openDate}` та всі orderingSessionId-scoped доменні правила.
- Додано `closeAt` + `scheduleSnapshot` до нових OrderingSession.
- Додано startup preflight для немігрованих/некоректних груп.
- Додано dry-run/apply migration зі старого global schedule без silent rounding.
- Заблоковано небезпечне редагування schedule/day під час open window, active current/next Orders, active PickingTasks та active picking lifecycle.
- Додано guard проти collision/revival старої використаної session.
- Picking schedule API став group-scoped.
- Telegram ordering-open notifier, supplements, seller/shop moves, product archive, orders/picking/session resolution переведено на group.orderingSchedule.
- Live functional/MASS harness переведений на synthetic per-group schedule; global setting не мутується.
- Додано unit/contract/session-identity тести та operations guide.
