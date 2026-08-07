# 2026-08-07 — Picking forward route + server-authoritative progress

## Scope

Base: `server(20260807-152158).zip` + `client(20260807-152130).zip`.

This change intentionally does **not** change PickingTask/Order/OrderingSession status enums.
The OOS completionReason/orphan-recovery audit remains analysis-only for the next step.

## Changes

### 1. Forward-only physical picking route

`services/pickingService.findAndLockNext()` now uses a real cursor:

- `(blockId, positionIndex)`
- scans only forward;
- never wraps to the beginning;
- completed positions are skipped;
- the first `locked` active task ahead is a hard route barrier;
- a worker does not jump over another worker.

After completing/OOS a task, the server uses the **actual completed task**
`blockId + positionIndex`, not a client-invented cursor.

When a colleague is reached:

- response contains `routeBlocked: true`;
- client warns the worker;
- current route ends;
- blocks overview opens so the worker chooses a new block.

### 2. Session isolation hardened

Automatic picking reads are scoped by both:

- `deliveryGroupId`
- `orderingSessionId`

Updated current-session scoping for next-task, my-task, block task picker,
blocks overview, queue counters and locked-task list.

`taskBuilder` no longer adopts an old active task into a new session:

- session-scoped build only discovers tasks from that session;
- `orderingSessionId` is never rewritten while appending items.

`sessionCoverage` and `reconcileActiveTasksForSession` now inspect only their
own ordering session.

`lateOrderReconcile` can only append to pending tasks of the same ordering
session and no longer rewrites task session membership.

### 3. Server-authoritative checkbox progress

Removed `localStorage` picking-progress backup.

Before:
- browser backup could survive a released/stolen lock;
- when the same task was later re-acquired, old browser state could override a
  newer server state.

Now:
- every checkbox change starts a server save immediately;
- server `task.items[].packed` is the only durable state;
- in-memory retry/backoff remains while the page is alive;
- task switching is blocked until latest progress is saved;
- pagehide still sends a keepalive save;
- heartbeat remains separate;
- `expired_lock` drops pending local intent instead of replaying it later.

## Explicitly not changed

- `PickingTask.status`
- `PickingTask.completionReason`
- `OrderingSession.pickingStatus`
- OOS orphan sweep predicate
- archiveProduct session-finalisation behaviour

Those require/receive a separate dependency audit before changing status-driven logic.

## Validation

- `node --check`:
  - `services/pickingService.js`
  - `services/taskBuilder.js`
  - `services/sessionCoverage.js`
  - `services/lateOrderReconcile.js`
  - `routes/picking.js`
- TypeScript parser (`tsc --allowJs --jsx react-jsx --noEmit --noResolve`) accepted:
  - `src/hooks/usePickingProgressSync.js`
  - `src/hooks/usePickingTaskFlow.js`
  - `src/components/picking/PickingReadySessionView.jsx`

Full npm tests/build were not executed in this sandbox because the uploaded
archives do not contain `node_modules`.
