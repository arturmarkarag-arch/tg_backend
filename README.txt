BaseLinker DB cleanup — SINGLE ACCOUNT
======================================

WHAT IT CLEARS
--------------
Only the BaseLinker domain:
- BaseLinkerOrderCache
- BaseLinkerOrderSnapshot
- BaseLinkerPickingOrder
- BaseLinkerPrintJob
- BaseLinkerPrintAgent (ephemeral; the PC agent registers again)
- AppSetting keys:
    baselinker.queueSettings.v1
    baselinker.orderCache.v2
    baselinker.journal.v1

It does NOT touch ERP orders/products/users/receipts/etc.
After cleanup, BaseLinker queue statuses (Intake/Sent/Cancelled) must be configured again.
Indexes are sync'ed to the current single-account schemas, removing retired accountScope indexes.

TEST DATABASE
-------------
IMPORTANT: TEST uses the same safety mechanism as the live TEST suites.
It MUST be launched with ../dev-use-test-db.js.

1) Dry-run:
   node -r ../dev-use-test-db.js scripts/cleanupBaseLinkerDb.TEST.js

   or:
   npm run cleanup:baselinker:test

2) Read the printed db name. Then execute with that exact name:
   node -r ../dev-use-test-db.js scripts/cleanupBaseLinkerDb.TEST.js --execute --confirm-db=THE_PRINTED_DB_NAME

The TEST script refuses to run unless TEST_ENV_LOADED is present and both the URI host and connected Mongo host pass utils/liveE2EDbGuard.js.

PRODUCTION DATABASE
-------------------
1) Dry-run:
   node scripts/cleanupBaseLinkerDb.PROD.js

   or:
   npm run cleanup:baselinker:prod

2) Read the printed db name. Then execute with BOTH confirmations:
   node scripts/cleanupBaseLinkerDb.PROD.js --execute --confirm-db=THE_PRINTED_DB_NAME --confirm-production=WIPE_BASELINKER_PROD

The PROD script refuses to run if TEST_ENV_LOADED is present or if the Mongo host matches the TEST Atlas host guard.

SAFETY
------
- Dry-run by default.
- Exact database-name confirmation is mandatory for every execute.
- PROD requires an additional literal confirmation token.
- TEST and PROD are separate files, not a mode switch.
- Post-cleanup verification requires all BaseLinker collections/settings to be empty.
- No automatic account migration/merge is performed.
