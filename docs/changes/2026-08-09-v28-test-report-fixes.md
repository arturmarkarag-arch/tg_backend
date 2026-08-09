# 2026-08-09 — V28 fixes after V27 full test report

## Server changes

- `services/sessionCoverage.js`
  - coverage audit now includes all non-`expired` Orders of the current session, not only `new|in_progress`;
  - coverage repair performs an additional **session-scoped** reconciliation after product archival;
  - a dangling line in `fulfilled|confirmed|cancelled` is marked terminal (`cancelled=true`) without rewinding the already-terminal Order status;
  - active Orders still use the canonical `resolveOrderStatusAfterCancel()` rule;
  - repair re-runs `maybeCompleteSession()` after the scoped terminal-line repair.
- `scripts/helpers/perGroupTestSchedule.js`
  - removed the obsolete test assumption `deliveryDay === closeDay`;
  - generated open/closed schedules are short, share one start boundary and self-validate through `validateOrderingScheduleDeliveryDay()`;
  - handles midnight/week-boundary runs without creating an almost-seven-day synthetic window.
- `tests/perGroupSchedule.contract.test.js`
  - removed brittle literal expectation for `normalizeOrderingSchedule(orderingSchedule)`;
  - checks the real create-path validator instead.
- Added `tests/sessionCoverageTerminalRepair.test.js`.
- Added `tests/perGroupTestSchedule.test.js`.
- DeliveryGroup deletion no longer leaves new orphan sessions:
  - empty read-created `pending` sessions are deleted together with an otherwise deletable group;
  - used/historical sessions block physical group deletion with `group_has_history`.
- Server package lock re-synchronised with `package.json` using `npm install --package-lock-only --ignore-scripts`.

## Safety decisions

- The production delivery-day validator was **not weakened**.
- Product archival was **not broadened globally** to rewrite historical fulfilled Orders. Terminal repair is limited to the exact `deliveryGroupId + orderingSessionId` being repaired.
- Historical sessions are not cascade-deleted.

## Validation performed in the build environment

- `node scripts/smokePerGroupSchedule.js` — PASS.
- `node --check` — 185 JS files, 0 syntax errors.
- `npm ci --ignore-scripts --dry-run` — PASS for lockfile consistency.
- Full `npm ci` could not complete in this environment because the internal package mirror returns 404 for `yocto-queue@1.2.2`; therefore Vitest/live E2E/MASS must be run locally per the V28 instructions.
