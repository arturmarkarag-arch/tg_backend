WHO_ORDERED_500_BACKEND_PATCH_20260908

Manual replacement patch for the backend repository root.

Replace/add these files preserving paths:
- routes/products.js
- tests/whoOrderedLiveCycle.test.js
- docs/changes/2026-09-08-who-ordered-read-hardening.md

What is fixed:
- GET /api/v1/products/:id/who-ordered no longer crashes the whole request when one DeliveryGroup has a missing/invalid orderingSchedule.
- The read path skips only that invalid group; it does not invent a fallback schedule.
- Malformed productId is rejected as validation_failed instead of falling into a Mongoose CastError/HTTP 500.
- The endpoint remains read-only: it resolves an existing session with findCurrentSessionId and does not materialize/create sessions.
- Legacy cartState is not used as current-order truth.

No DB migration. No frontend changes required.

Validation performed on this patch:
- node --check routes/products.js: PASS
- node --check tests/whoOrderedLiveCycle.test.js: PASS
- direct runtime probe of pickLastOpenedGroup with real orderingSchedule helper: PASS
- route static contract: no cartState, no getOrCreateSessionId, findCurrentSessionId present, productId guard present: PASS

Full Vitest suite was not executed in the isolated archive because node_modules are not included.
