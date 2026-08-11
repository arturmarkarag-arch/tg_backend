# Picking resume lease hardening — v31 (2026-08-11)

## Problem
A Telegram/React client can stay frozen in the background while its picking task lease expires. Another worker may take or finish the task, but the old React tree still renders the stale task card. On the next tap the worker only sees `expired_lock`, with no explanation of what changed.

## Changes
- Unified ordinary picking stale cleanup and force-claim at one 5-minute lease boundary.
- Supplement takeover timeout moved to the same 5-minute boundary because it explicitly shares the picking lease policy.
- Heartbeat now refreshes only a fresh lease; a client returning after >5 minutes cannot resurrect an expired lock.
- Heartbeat returns an ownership state: `mine`, `available`, `other_worker`, `completed`, `session_changed`, or `missing`.
- A stale self-owned lease is atomically released before reporting `available`.
- Client heartbeat runs immediately when a task activates and on `visibilitychange`, `pageshow`, and `focus` (throttled to one request per resume burst).
- If the task is still available, the client reclaims the same task and continues from server-saved progress.
- If another worker owns/completed it, the stale task card is removed immediately and the live block overview is opened with a clear explanation.
- `expired_lock` from a progress write also enters the same recovery path instead of leaving a dead card.

## Safety properties
- Server remains the only durable source of checkbox/progress state.
- No automatic resume into a task from an old ordering session.
- Reclaim uses the existing atomic claim endpoint, so a race with another worker has one winner.
- Heartbeat never treats a network error as proof that ownership was lost.
