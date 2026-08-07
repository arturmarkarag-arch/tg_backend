# Conflict boundary + closure integrity — 2026-08-07

## Contract restored

- Cross-seller shop conflicts are a **pre-picking start gate only**.
- `sessionClosure` no longer blocks picking completion on `shop_order_conflicts`.
- If a conflict appears after picking started, closure audit returns it as a warning only.
- Dedicated conflict resolution no longer requires a completely empty target shop.
  Staff may move to any active shop or unassign; the canonical pre-start gate re-evaluates
  the result and remains blocked if the destination now has active Orders from 2+ buyers.

## Invisible closure blocker hardening

- Closure audit now queries session-owned active PickingTasks by `orderingSessionId` first
  and separately reports a wrong `deliveryGroupId` as `session_task_group_mismatch`.
- Closure audit now queries Orders by `orderingSessionId` first and reports a wrong/missing
  snapshot group as `session_order_group_mismatch`.
- `finalizeSessionAndGetBlockers` no longer silently suppresses diagnostics when the only
  remaining active task belongs to the session but carries the wrong group.
- Shift Board renders the exact current-session blocker details and renders shop conflicts
  as non-blocking warnings.

Historical orders/tasks/sessions remain warnings only and never block a later cycle.

- Intentionally parked Orders (seller unassigned: no shop/group snapshot) are warnings, not group-mismatch blockers.
