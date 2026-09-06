BaseLinker integrity P0 patch · 2026-09-06
Baseline: server_FULL_SINGLE_ACCOUNT_TRISTATE_14D_FRESH_STATUSES_LOCAL_WORKFLOW_20260906.zip

Changes:
- one per-order distributed lock namespace: baselinker-order:<orderId>
- Mongo/Mongoose optimistic concurrency for BaseLinkerPickingOrder saves
- active local workflow retained even when upstream moves to ordinary non-Intake status
- disappeared orders beyond exact-recovery batch are retained for next pass, never swept unchecked
- packing no longer overwrites real upstreamDisposition with intake
- confirmed-only BaseLinker order reads (get_unconfirmed_orders=false)
- exact missing order blocks further warehouse mutation until upstream exists again

No BaseLinker accountScope logic is reintroduced.
No client/UI files are changed by this patch.
