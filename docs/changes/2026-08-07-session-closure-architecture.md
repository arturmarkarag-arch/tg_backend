# 2026-08-07 — Session closure architecture

## Goal
Make OrderingSession completion systematic: an archive/coverage repair can no longer remove the last work item without re-evaluating the affected session, and a session cannot become `completed` while integrity blockers remain.

## Server changes
- Added `services/sessionClosure.js` with canonical read-only `auditSessionClosure({ deliveryGroupId, orderingSessionId })`.
- Hard blockers: current-session active tasks, coverage gaps, direct non-expired unterminated order positions.
- Warnings only (not hard gates yet): orphan active tasks from another/no session, stale active orders from another/no session.
- `maybeCompleteSession()` keeps its old return contract (`OrderingSession | null`). It uses a cheap active-task fast path, then the central closure audit only when the queue reaches zero.
- `archiveProduct()` collects affected session IDs from changed Orders, closed open PickingTasks, AND unreconciled completed OOS tasks (crash-recovery case), then calls `maybeCompleteSession()` after transaction commit for every affected session.
- `resolveCoverageGap()` fallback (deleted/already archived product) now re-evaluates the session after directly cancelling dangling order items.
- complete/OOS responses include `sessionClosure` only when the worker reaches a quiescent queue and the session still has blockers.
- Added read-only `GET /api/picking/session-closure?deliveryGroupId=...`.
- Shift board now includes closure diagnostics and scopes pending/locked counters to the current session; foreign tasks are surfaced as warnings instead of inflating current-session counters.

## Deliberate non-changes
- No new PickingTask statuses.
- `packed`, `packedQuantity`, `completionReason`, Order status vocabulary, TTL and ranking semantics are unchanged.
- `stale_orders` and `orphan_tasks` are warnings only; they do NOT block current-session completion/start yet.
- Supplements remain outside OrderingSession closure lifecycle.

## Validation
- `node --check` passed for all changed server JS files.
- Full npm test could not run in this environment because the internal npm registry does not provide `yocto-queue@1.2.2`.
