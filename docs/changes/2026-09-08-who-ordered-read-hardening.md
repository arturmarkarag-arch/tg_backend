# 2026-09-08 — Who ordered read-path hardening

## Problem
The admin-only `GET /api/v1/products/:id/who-ordered` global mode selects the live delivery group by evaluating every group's weekly `orderingSchedule`.
A legacy or malformed DeliveryGroup with an unusable schedule could throw during that selection and turn the whole read into HTTP 500 (`internal_error`).

## Fix
- Keep schedule validation strict; do not invent a fallback schedule.
- In the global staff disclosure only, skip groups whose schedule cannot be evaluated.
- If no group has a usable schedule, return the existing empty `sections` response instead of crashing.
- Validate `productId` before the Mongo query so malformed ids return `validation_failed` (400) instead of a Mongoose CastError/500.
- Added regression coverage for malformed legacy groups.

## Data / writes
No DB migration. No data rewrite. The endpoint remains read-only and uses `findCurrentSessionId`; it does not materialize ordering sessions.
