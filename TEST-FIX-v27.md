# v27 test-harness fix

No production/session logic changed from v26.

Fixed only tests discovered by the first local `npm test` run:

1. Removed `require('vitest')` from four CommonJS test files. This project uses Vitest globals (`globals: true`), and Vitest v1.6 rejects importing its CJS entry via `require()`.
2. Updated `orderingOpenNotify.test.js` to the v26 contract: physical `deliveryDay` is independent from `orderingSchedule.endDay`, but must still belong to the same weekly session cycle.
3. Made `registrationHelp.contract.test.js` verify the actual required meaning/copy (`робочій групі «Оголошення»`, manager/admin guidance, `/start ще раз`) instead of brittle grammatical fragments.

Rerun:

```bash
npm test
```

Only after it is green continue with schedule tests / E2E / MASS.
