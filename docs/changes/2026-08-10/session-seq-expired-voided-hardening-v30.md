# Session seq + expired-item hardening — 2026-08-10

## Runtime

- `POST /orders/upsert-item` now triggers `ensureSessionSeq()` for every real touched order, fixing the canonical MiniApp path that previously never assigned `OrderingSession.seq`. `ensureSessionSeq()` also refuses to number a newer session while older content-bearing sessions in that group are still unnumbered, preventing an accidental post-deploy «current session = №1» before backfill.
- stale-order restore also triggers session numbering; picking confirmation is a final best-effort safety net for sessions that gained orders through admin/migration edge paths.
- `getOrCreateSessionId()` / next-session materialisation now reads an existing `{groupId, openDate}` first, so normal polling no longer executes a timestamped `findOneAndUpdate` against an already-existing session.
- OrderItem has an explicit order-retirement state: `voided`, `voidReason`, `voidedAt`.
- every current runtime transition to `Order.status='expired'` terminalises only still-open items as `voided`; packed/cancelled/skipped outcomes are preserved.
- picking/task/coverage/order-status live-item checks understand `voided` as terminal/non-deliverable.

## Migrations

- `scripts/backfillSessionSeq.js` — dry-run by default; numbers only sessions that actually contain Orders, independently per group, and seeds `session-seq:<groupId>` counters. Existing contradictory seq values abort instead of being rewritten.
- `scripts/backfillVoidedItems.js` — dry-run by default; marks still-open rows in historical `expired` Orders as `voided=true`, reason `order_expired`, with `voidedAt` approximated from the historical Order `updatedAt`. Strong post-write verify requires zero remaining open expired rows.

## UI / supplied files

- supplied `UserHistoryModal.jsx` is installed at `client/src/routes/users/UserHistoryModal.jsx`: `voided` lines render as «Погашено», `skipped` as «Пропущено». One review fix was applied: skipped rows are also treated as non-delivered/dead for price/muting, so they cannot look billable.
- user-history order status vocabulary includes `expired: Погашено`.
- seller-facing `MyOrdersPage` and `OrderHistorySection` also understand `expired`/`voided`/`skipped`, so retired positions cannot still look active or billable outside the admin history modal.
- supplied `_videoDemoSeed.js` is included under `server/scripts/` unchanged; it is a demo-only explicit-write tool and is not part of the migration.

## Existing picking change preserved

- manual task release remains enabled;
- stale picking lock timeout remains 5 minutes;
- 3-minute force-claim threshold remains unchanged.
