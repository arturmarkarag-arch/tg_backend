# V48.S2.2 — Live Gate Round 2 Fix — 2026-08-17

## Scope
Harness-only reliability fixes discovered by the first real TEST-Atlas V48.S2 live release gate. Product/domain S2 behavior is unchanged.

## Receipt live harness fixture
`liveReceiptLifecycleE2E.js` now creates one active synthetic `Shop` for every synthetic current `DeliveryGroup`, matching the S2 `supplement_target_no_shops` invariant.

The Shop is fully test-owned:
- stored in `ids.shops`;
- persisted in the receipt run manifest as `shopIds`;
- deleted by normal `cleanupPass()`;
- counted by `receiptLeftoverCounts()` so stable-zero cleanup includes it.

Crash-safe cleanup in `liveOrderPickingE2ECleanup.js` was extended as well:
- reads manifest `shopIds`;
- marker-fallback discovers Shops created before the next manifest save;
- counts exact receipt-owned Shops;
- deletes them before their DeliveryGroups.

## Real server boot budget
The `WEB_CONCURRENCY=2` without Redis refusal probe now uses a named `MULTI_WORKER_REFUSAL_TIMEOUT_MS = 45_000` budget instead of a brittle 8-second load-time budget. The process still must exit non-zero; a real hang still fails the gate.

## Preserved prior harness fixes
- Windows `npm.cmd` release-gate runner compatibility: `shell: isWindows`.
- MASS HTTP timeout calibration: default 90s, capped below the 120s no-progress watchdog, flag/env overridable.

## Regression guards
`checkLiveHarnessV48_18.js` and `liveHarnessV4818.contract.test.js` now assert:
- tracked active Shop seeding for receipt current groups;
- Shop normal cleanup + stable-zero accounting;
- Shop crash-manifest recovery cleanup;
- 45s real-server refusal load budget;
- existing Windows release-gate shell guard.

## Verification in packaging environment
- `npm run test:release:static`: PASS 23/23
- V48.S2 server checker: PASS 33/33 (included in release static)
- live harness static: PASS 79/79
- recursive `node --check`: 306 files, 0 failures

Full Vitest/live TEST-Atlas execution is not claimed in this packaging container. The next required proof is to rerun the complete 8-step live release gate on the Windows working tree against guarded TEST Atlas.
