# 2026-08-09 — v25 per-group ordering schedule corrections

Основа: v24 per-group schedule.

## Контракт

- `DeliveryGroup.dayOfWeek` = день доставки = день закриття ordering-session.
- `orderingSchedule.startDay/startHour/startMinute` індивідуальні для групи.
- `orderingSchedule.endHour/endMinute` індивідуальні для групи.
- `orderingSchedule.endDay` зберігається для snapshot/self-contained calendar, але завжди синхронізується з `dayOfWeek`.
- UI week order: Monday → Sunday; internal JS day numbering unchanged.

## Save/persistence

- PATCH canonicalizes `endDay` from requested delivery day.
- PATCH rereads the saved DeliveryGroup from Mongo before responding.
- SettingsPage merges PATCH response into the canonical `delivery-groups` React Query cache before background refetch, preventing stale old hours from flashing/reappearing.
- Added persistence test for edited nested orderingSchedule.

## Schedule edit safety

- Pure clock state (`isOpen=true`) no longer blocks editing an otherwise empty group.
- Any Order or PickingTask in current/next protected sessions still hard-blocks calendar edits.
- Any current picking lifecycle state other than `pending` still hard-blocks edits.
- Empty pending session bounds/snapshot may be refreshed safely; already-sent `openNotifiedAt` is preserved.

## Migration/preflight

- Dry-run/apply migration now also repairs valid v24 schedules where `endDay != dayOfWeek`.
- Startup preflight rejects raw DB drift between `dayOfWeek` and `orderingSchedule.endDay`.
- DeliveryGroup schema pre-validation synchronizes `endDay` to `dayOfWeek` for ordinary model writes.

## Test harness

- Synthetic functional/MASS schedule helper now guarantees `deliveryDay === openSchedule.endDay === closedSchedule.endDay`, including near midnight.
- Warehouse auto-test group derives its synthetic delivery day from the generated close day.
