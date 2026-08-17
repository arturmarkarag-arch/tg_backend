# V48.S2.1 — Windows live release gate spawn compatibility

Date: 2026-08-17

## Problem

The S2 full-reconstructed package reverted a pre-existing Windows compatibility fix in `scripts/runLiveReleaseGateV48_18.js`.
On Node >= 18.20 / 20.12, spawning `npm.cmd` directly without a shell can fail with `EINVAL` after CVE-2024-27980 hardening. The live gate then stopped at the first step with `exit=unknown` even though the preflight command itself passed when executed directly.

## Fix

- Restore `const isWindows = process.platform === 'win32'`.
- Spawn `npm.cmd` with `shell: isWindows`.
- Keep script names as fixed literals; no user-controlled shell command is introduced.
- Add a harness-static guard requiring both the Windows branch and `shell: isWindows`.
- Add the same source contract to `tests/liveHarnessV4818.contract.test.js`.

## Verification

- `node --check scripts/runLiveReleaseGateV48_18.js` — PASS
- `node --check scripts/checkLiveHarnessV48_18.js` — PASS
- `node --check tests/liveHarnessV4818.contract.test.js` — PASS
- `npm run --silent test:harness:static` — 75/75 PASS

This closes the third full-tree rollback observed after S2 packaging (after redeemShopInvite test stub and MASS timeout calibration).
