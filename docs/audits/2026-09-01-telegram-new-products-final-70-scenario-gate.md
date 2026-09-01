# Telegram «Нові Товари» — final 70-scenario gate

**Date:** 2026-09-01  
**Baseline:** dedicated `TelegramDestination → TelegramPublication → TelegramPublicationBinding → TelegramPublicationEvent` lifecycle after hardening.

Legend: ✅ PASS; ⚠️ documented external/library limitation; ❌ FAIL.

## Result

- **67 ✅ PASS**
- **3 ⚠️ documented limitations**
- **0 ❌ FAIL**
- **0 critical/high lifecycle blockers left in this static/state-machine gate**

The three limitations do not silently corrupt lifecycle state: they surface an actionable/manual state.

## A. Create / update lifecycle

| # | Scenario | Final | Why |
|---|---|---|---|
| A1 | Confirmed item → first Publish | ✅ | Durable Publication queued; physical Binding created transactionally before `sendPhoto`. |
| A2 | Double Publish same canonical payload | ✅ | Applied/current hash and generation rules prevent duplicate create. |
| A3 | Two Publish decisions while worker `sending` | ✅ | Desired payload updates in-flight; success converges to queued update when hashes differ. |
| A4 | Price / qty / comments changed | ✅ | Canonical payload changes and updates current Binding. |
| A5 | Photo changed | ⚠️ | `editMessageMedia` is correct, cached `file_id` recovery exists; canonical URL must remain fetchable for current library path. |
| A6 | Canvas-only visual movement | ✅ | Not in canonical hash. |
| A7 | Route changed and label changes | ✅ | Full route signature participates in hash. |
| A8 | Route changed while coarse label could stay same | ✅ | `warehouse/mandatory/supplement/mayNotReachAllShops/supplementDeliveryGroupId` are hashed. |
| A9 | External route/batch change; panel itself is pristine | ✅ | Server returns `action=update`; recovery UI exposes `Оновити Telegram` independently from Save. |
| A10 | Skip first publication then change mind | ✅ | Confirmed `not_sent/publish` has explicit `Опублікувати в Telegram`. |
| A11 | Group disabled during confirm then enabled | ✅ | Same explicit publication action; no fake form edit required. |

## B. Manual Telegram deletion / identity

| # | Scenario | Final | Why |
|---|---|---|---|
| B1 | Post manually deleted; later update | ✅ | `message to edit not found` and `MESSAGE_ID_INVALID` → `missing`. |
| B2 | Post deleted with no product edit | ✅ | Active verify on open/focus/manual action detects missing; no fake Save dependency. |
| B3 | Legacy `failed + MESSAGE_ID_INVALID` | ✅ | Read/migration normalization recovers to missing semantics. |
| B4 | Missing → manual Republish | ✅ | New Binding generation; old Binding history is preserved. |
| B5 | Cached Telegram `file_id` invalid | ✅ | Cache is dropped once and canonical original photo is tried. |
| B6 | Manual Telegram caption edit | ⚠️ | App owns Telegram representation; verify/update may restore app-owned caption by explicit policy. |

## C. DELETE / unconfirm / safe mode

| # | Scenario | Final | Why |
|---|---|---|---|
| C1 | Draft/unpublished delete | ✅ | No physical cleanup unless ledger evidence exists. |
| C2 | Sent unused confirmed item delete | ✅ | Exact cleanup queued in same transaction before source deletion. |
| C3 | Item used by Block/Order/Picking/Supplement | ✅ | Safe-mode 409 blocks source and Telegram destructive flow. |
| C4 | Missing then source DELETE | ✅ | Known old ref can be cleanup-attempted; already absent is success. |
| C5 | `unknown` create then DELETE | ✅ | No-message Binding becomes durable `manual_required` ambiguous cleanup. |
| C6 | `unknown` create then unconfirm | ✅ | Same ambiguity persists outside ReceiptItem as ledger/cleanup evidence. |
| C7 | Unknown → force retry succeeds → DELETE | ✅ | Old unknown and new live post are separate Bindings; destructive flow sees both. |
| C8 | Reconfirm/new create before old cleanup/reconciliation | ✅ | New physical generation is blocked by open cleanup or historical no-message ambiguity. |
| C9 | Cleanup 429/5xx | ✅ | Durable retry/backoff. |
| C10 | Cleanup message already absent | ✅ | Desired end state → done. |
| C11 | Telegram cannot delete old/right-restricted post | ⚠️ | Becomes durable `manual_required`; operator can retry or mark resolved. Telegram's own deletion limits remain external. |
| C12 | Admin manually cleaned manual-required post | ✅ | `Позначити очищеним` closes cleanup with audit metadata. |
| C13 | Rights restored after manual-required exact cleanup | ✅ | Explicit retry endpoint/action requeues exact cleanup. |

## D. Races / crashes / multiple instances

| # | Scenario | Final | Why |
|---|---|---|---|
| D1 | DELETE/unconfirm vs worker | ✅ | Shared item lock, bounded Bot request timeout, fail-closed `unknown`, late-success exact cleanup. |
| D2 | Publish vs DELETE/unconfirm | ✅ | `recordDecision()` takes same item lock and re-reads confirmed source. |
| D3 | Worker after item became draft/deleted | ✅ | Claim requires confirmed sourceState; sender re-reads authoritative ReceiptItem before API. |
| D4 | Crash during known update | ✅ | Expired sending update → retry_wait. |
| D5 | Crash during create without response | ✅ | Expired create → unknown Binding, never blind retry. |
| D6 | Multiple worker instances | ✅ | Atomic claim + item lock + global delivery lane. |
| D7 | Bot object unavailable before API call | ✅ | `EBOTUNAVAILABLE` is retryable but explicitly non-ambiguous. |

## E. Group settings / bot rights

| # | Scenario | Final | Why |
|---|---|---|---|
| E1 | Malformed group ID | ✅ | Normalization rejects. |
| E2 | Inaccessible group / cannot post | ✅ | `getChat/getMe/getChatMember` validation. |
| E3 | Clear group ID | ✅ | Destination disabled; publication lane pauses. |
| E4 | Clear ID during active batch | ✅ | Destination switch re-read between every item; next Bot API call stops. |
| E5 | Change group with unsent creates | ✅ | Destination + legacy mirror + safe retarget + event are transactional. |
| E6 | Change group with already-sent posts | ✅ | Existing Binding keeps original historical chat. |
| E7 | Group disabled: existing updates pause | ✅ | Full destination pause by explicit policy. |
| E8 | Telegram `migrate_to_chat_id` | ✅ | Destination/Publication/Binding/Cleanup references migrate transactionally. |
| E9 | Bot kicked / rights changed | ✅ | `my_chat_member` updates current destination and historical affected Bindings. |
| E10 | Settings opened after rights loss | ✅ | Live inspect refreshes health. |
| E11 | Own-post delete permission semantics | ✅ | Operational delete capability follows ability to remove bot's own outgoing posts; UI no longer falsely requires `can_delete_messages` alone. |

## F. Network / Bot API semantics

| # | Scenario | Final | Why |
|---|---|---|---|
| F1 | 429 + retry_after | ✅ | Exact retry delay preserved. |
| F2 | 5xx during known update | ✅ | Safe retry. |
| F3 | Timeout/reset during create | ✅ | Explicit unknown ambiguity. |
| F4 | 5xx during create | ✅ | Same no-blind-retry rule. |
| F5 | `MESSAGE_ID_INVALID` | ✅ | `message_not_found` → missing. |
| F6 | `MESSAGE_NOT_MODIFIED` | ✅ | Idempotent success/existence signal. |
| F7 | Original photo URL itself unavailable | ⚠️ | Actionable failure requiring source photo repair; no silent success. |
| F8 | Cached `file_id` unavailable | ✅ | One fallback to canonical URL. |
| F9 | Unauthorized/forbidden/chat-not-found during delivery | ✅ | Delivery transition is durable; current Destination or historical Binding health is updated at the proper level. |

## G. Operational recovery / UI

| # | Scenario | Final | Why |
|---|---|---|---|
| G1 | Failed publication → Retry | ✅ | Explicit retry independent from Save. |
| G2 | Missing → Republish | ✅ | Explicit direct action. |
| G3 | Unknown; operator confirms no post | ✅ | Resolve current ambiguity absent, then safe new create is available. |
| G4 | Unknown; operator confirms post exists | ✅ | `chatId/messageId` attach + verify; historical unknown becomes exact duplicate cleanup. |
| G5 | Possible duplicate after later success | ✅ | Separate unresolved Binding generation remains durable until reconciliation. |
| G6 | Manual cleanup issue in Settings | ✅ | Retry + Mark resolved; exact and ambiguous context is visible. |
| G7 | Stale due external route command | ✅ | `action=update` exposes `Оновити Telegram`, including pending delivery states. |
| G8 | Intentional skip then publish | ✅ | `Опублікувати в Telegram` exists without irrelevant item edit. |

## H. Data / payload correctness

| # | Scenario | Final | Why |
|---|---|---|---|
| H1 | Caption > 1024 | ✅ | Bounded/truncated. |
| H2 | Decimal display | ✅ | Compact canonical formatting. |
| H3 | Exact route semantics | ✅ | Canonical route signature is hashed. |
| H4 | Canvas-only label movement | ✅ | Does not alter Telegram payload. |
| H5 | Desired payload changes while create in flight | ✅ | `markSuccess` queues convergence update instead of declaring stale payload current. |

## Additional final-gate invariants added after the original 70-scenario audit

1. Binding + Publication + Event failure transitions are transactional for missing/ambiguous/retry-terminal paths.
2. `possibleDuplicate` is **not** synonymous with every unresolved problem; only no-message ambiguity sets it.
3. Historical no-message ambiguity blocks another physical generation even when no cleanup row exists yet.
4. Explicit force retry exempts only the current unknown binding; it never suppresses older unresolved ambiguity.
5. Startup repairs issue counters for documents produced by the first ledger rollout.
6. Save-form warnings distinguish destination health, binding access, photo source and reconciliation blockers.

## Automated/static gate executed

- Server architecture: **62/62 PASS**
- Client Telegram UI/state contract: **28/28 PASS**
- Full server JS syntax gate: run separately in release report
- Full client JS/JSX parser gate: run separately in release report

## Remaining verification boundary

This gate validates architecture/state-machine/source contracts without a live Telegram channel and without a runnable dependency tree in the supplied archive. A production deploy should still execute the repository's Vitest/build suite and a controlled Telegram smoke test in the normal project/CI environment.
