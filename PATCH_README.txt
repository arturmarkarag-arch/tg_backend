BaseLinker claim race guard — server manual patch — 2026-09-05

Purpose
- Prevent two BaseLinker workers from successfully taking the same logical order at the same time.

What changed
- MongoDB is now the final authority for claim ownership; Redis/process locks remain only contention reducers.
- Added deterministic `claimKey` with a unique sparse index as a DB backstop for logical grouped orders. The first claim explicitly waits for that Mongo index, so correctness does not depend on background autoIndex timing.
- First claim is one atomic insert. Concurrent loser hits E11000, reloads the winner, and receives the normal 409 taken response.
- Existing-order claim is one compare-and-swap `findOneAndUpdate` guarded by exact revision + claimable owner/stale/admin predicate.
- Ownership, upstream sync, items, history, status and revision are committed together by that CAS.
- Legacy rows get `claimKey` lazily on their next claim; no bulk migration is required.

No BaseLinker mutation was added. Upstream remains read-only.

Files
- models/BaseLinkerPickingOrder.js
- services/baseLinkerPicking.js
- tests/baseLinkerClaimRace.contract.test.js
