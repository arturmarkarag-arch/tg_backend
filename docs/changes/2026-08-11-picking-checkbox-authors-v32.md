# 2026-08-11 — Picking checkbox authors (v32)

## Problem
Partial picking progress already survived task release / stale-lock hand-off, but each `PickingTask.items[]` entry only stored `packed: true|false`. A worker inheriting a partially picked task could see the old ticks but the UI could only say “зібрано попереднім”, with no reliable identity of who made each physical placement.

## Change
- Added `packedBy`, `packedByName`, `packedAt` to every PickingTask item.
- Progress PATCH stamps the authenticated worker only on a `false -> true` checkbox transition.
- Re-saving an already-checked box preserves the original author; a new worker cannot steal attribution by merely opening/saving the task.
- Unchecking clears the old author. Re-checking later attributes the new worker.
- Explicit release, normal completion and out-of-stock finalization carry the same fallback attribution rules.
- `buildTaskResponse()` exposes the per-item author to React.
- The inherited mark label is now `Відмітив: <ім'я>` instead of the generic `зібрано попереднім`.
- Legacy already-checked task items created before v32 can have no author; React shows `Автор відмітки не збережений` for those only.

## Expected hand-off
1. Worker A checks shops 2 and 5. Server stores the two ticks with Worker A's Telegram id/name.
2. Worker A leaves / lease expires without completing the task.
3. Worker B claims the same task and receives shops 2 and 5 as checked plus Worker A's name on those exact ticks.
4. Worker B checks shop 7. Shops 2/5 remain attributed to A; shop 7 is attributed to B.
5. If B deliberately unchecks A's shop 2 and later checks it again, the new tick belongs to B.

## Verification
- Server JS syntax: `node -c` on changed server files.
- Static contract tests added on server and client to protect author fields, transition semantics, API response and UI wording.
