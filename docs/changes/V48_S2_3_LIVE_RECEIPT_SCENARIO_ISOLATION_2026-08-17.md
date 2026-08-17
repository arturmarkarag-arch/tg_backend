# V48.S2.3 — Live Receipt Scenario Isolation — 2026-08-17

## Trigger
The real TEST-Atlas gate reached step 4 (`test:live:receipt`) after the S2.2 active-Shop fixture fix. Both batch publication requests returned HTTP 200, but Scenario 4 failed:

`group A receives its own Wave item: actual=5, expected=1`

TEST cleanup remained clean (`rows=0`, `manifests=0`, lease released, fingerprints unchanged).

## Root cause
This is harness state bleed, not a Wave/domain defect.

The modern v2 supplement batch endpoint intentionally scans the whole confirmed target-neutral ready pool. Vitest isolates each case with database cleanup, but `liveReceiptLifecycleE2E.js` executes every scenario sequentially in one shared TEST-Atlas run.

Before Scenario 4 the harness itself had left four earlier confirmed v2 supplement items eligible:
- 1 item from Scenario 2;
- 3 items from Scenario 3 (`open`, `frozen`, `completed`).

Scenario 4 then seeded one more item, so the correct production endpoint selected 5 rows. Simply changing the assertion to 5 would be wrong: the Scenario 4 item would remain target-neutral and bleed into later Scenario 9 race publications too.

## Fix
Added harness-only `retireTargetNeutralFixture(item)`.

After a scenario has finished asserting a modern/compatibility supplement fixture, the helper sets only that synthetic item's `supplementBatchVersion` to `0`. This removes the finished fixture from future target-neutral batch selection while preserving the product code and the already-observed Wave/Offer facts for that scenario until normal final cleanup.

Retirement is applied after:
- Scenario 2;
- every Scenario 3 status case;
- Scenario 4 after its same-session idempotency assertion;
- Scenario 8;
- the first Scenario 9 race before the second race starts;
- the final race when the item still exists.

This gives the single-process live suite the same scenario isolation that per-test database reset gives Vitest.

## Additional TEST-Atlas safety guard
Receipt live preflight now refuses to execute if TEST already contains an unrelated publishable target-neutral v2 supplement item on a completed receipt.

Reason: the publication endpoint is deliberately global for the selected current delivery cycle. Without this guard, a synthetic live-gate group could attach unrelated TEST data to a synthetic Wave. The safe behavior is to refuse the live suite rather than mutate non-harness data.

## Regression guards
`checkLiveHarnessV48_18.js` and `liveHarnessV4818.contract.test.js` now require:
- target-neutral fixture retirement between shared-DB scenarios;
- at least five explicit retirement points;
- the ambient publishable-v2 preflight refusal.

## Preserved S2.1/S2.2 fixes
- Windows `npm.cmd` gate runner uses `shell: isWindows`;
- MASS HTTP timeout default 90s, below 120s watchdog;
- real-server multi-worker refusal load budget 45s;
- synthetic active Shops are tracked in receipt manifests, normal cleanup, stable-zero checks, and crash cleanup.

## Verification in packaging environment
- `npm run test:release:static`: PASS 23/23
- V48.S2 checker: PASS 33/33
- live harness static: PASS 81/81
- recursive `node --check`: 306/306

Full live TEST-Atlas 8/8 is not claimed here. Required next proof: rerun `test:live:receipt`, then the full 8-step release gate on the guarded Windows TEST environment.
