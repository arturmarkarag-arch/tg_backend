BaseLinker upstream-change UX hotfix 2026-09-06
Apply over server_FULL_SINGLE_ACCOUNT_TRISTATE_14D_ID_INDEX_INTAKE_STATUS_GATE_20260906.
Changes:
- visible tracked Intake orders are compared with live BaseLinker payload on page read;
- quantity/product changes are stored as compact change details in PickingOrder;
- no full BaseLinker order mirror is reintroduced.
Restart backend after replacing files.
