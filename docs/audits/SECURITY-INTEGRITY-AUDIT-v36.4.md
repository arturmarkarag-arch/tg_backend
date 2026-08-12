# Security / integrity audit — v36.4

Date: 2026-08-11

## Scope

Audit focused on:
- authoritative picking screen selection and stale-response races;
- auth/role boundaries and deliberate bypass attempts;
- cross-session data integrity and destructive query scope;
- Mongo transactions/index/session invariants;
- historical retention and data-loss resistance;
- unexpected read-path mutations;
- browser/reverse-engineering exposure;
- R2 temporary uploads and edge abuse surface;
- Render/Vercel/Cloudflare deployment hardening.

## Fixed in v36.4

### 1. Picking screen selection / race conditions
- Server owns `presentationMode`.
- `idle` and `completed` terminal cycles both enter `upcoming_preflight` within 24h of the next ordering opening.
- Client does not render a business card until the selected group's authoritative snapshot resolves.
- Group switch uses a synchronous `resolvedGroupId` guard, so the old group's card cannot flash for one paint before effects run.
- Late responses from start/cancel/coverage/supplement/task-restore flows are ignored after group switch.
- `loading` has higher render priority than supplement/preflight/session cards.
- Screen priority is now a pure `derivePickingScreenKey()` state machine with unit tests, rather than an accidental JSX branch order.
- Client no longer owns a duplicate 24h preflight calculator; the server timestamp + presentation mode are authoritative.

### 2. Unexpected read-path mutations
- `GET /picking/session-status` now uses `findCurrentSessionId`; seller polling cannot create an empty `OrderingSession`.
- Readiness/queue/shop-status/conflict/product reads use non-materialising session lookups where identity creation is not part of the business operation.
- `GET /picking/my-task` still performs a narrow legacy duplicate-lock read-repair by design; it is session/group/worker scoped.
- Legacy `GET /picking/next-task` is still a mutating GET and should be migrated to POST in a compatibility-safe release (old clients may still call it).

### 3. Security boundaries / bypass resistance
- Destructive `/api/warehouse-test` is disabled unless `NODE_ENV != production` AND `ENABLE_TEST_API=true`; the API is admin-only and never public-allowlisted.
- Production CORS fails closed. Explicit `CORS_ALLOWED_ORIGINS` wins; otherwise `WEB_APP_URL` is the only fallback origin.
- `/api/bot-status` is admin-only.
- Public health/maintenance payloads no longer expose internal technical details.
- Raw Mongoose validation details are only returned to admin/warehouse.
- Seller-facing Gemini/Atlas failures no longer expose raw provider errors or the internal vector-index name; staff can still receive diagnostic `details`.
- Vercel baseline headers added: `nosniff`, strict referrer policy, restrictive permissions policy while preserving camera access.
- Production source maps remain disabled by default.
- New live `security_boundaries` scenario actually attempts unauthenticated user creation, seller self-promotion, seller receipt/picking access, destructive test API access and public catalogue enumeration, then verifies rejected requests did not mutate Mongo.

### 4. Cross-session integrity
- `detachOrderFromPendingTasks()` now captures exact affected task IDs before `$pull` and only removes emptied tasks from that set. It no longer runs a global empty-task delete across unrelated groups/sessions.
- Existing unique session/task indexes and transaction/CAS paths remain the main data-integrity barrier.

### 5. Historical data retention
- Completed sessions now freeze compact counters in `OrderingSession.finalSummary`.
- Historical UI reads `finalSummary` after detailed `PickingTask` rows are purged.
- Explicit late-order reopen invalidates the old frozen summary and the next completion writes a fresh one.
- Old completed sessions without a snapshot are lazily backfilled while their detailed task history is still available.
- Live `final_summary_retention` deletes completed tasks only for its synthetic session and proves the historical session remains `completed` with correct counters and unchanged fulfilled Order.

### 6. Multi-instance background work
- Ordering-open, supplement and retention scheduler ticks are wrapped in the shared distributed leader lock.
- With Redis configured, only one horizontal instance performs a given scheduler tick; Mongo CAS/idempotency remains the source-of-truth protection underneath.

## Verified positive controls

- `/api/users` is protected at router level by both `telegramAuth` and `admin` role gate; the apparent unguarded individual handlers are not seller-accessible.
- No direct `Model.find(req.body)` / equivalent operator-injection surface was found in runtime routes; free-text regex search escapes metacharacters.
- AppError responses do not expose stack traces.
- Test-only destructive scripts remain shell/test tooling rather than public runtime routes; the one HTTP test router is now explicit opt-in/admin-only.
- Critical Mongo unique-index startup checks already fail the application into read-only maintenance when index guarantees cannot be established.

## Intentionally not changed / follow-up design decisions

### Browser JWT storage
Browser JWT remains in `localStorage`. This means any future XSS can read the token. Moving to HttpOnly cookies requires an explicit CSRF/session design and should not be a drive-by patch. Current positives: token carries only telegramId, role/profile are re-read from Mongo on every request, and `sessionsValidFrom` supports global revocation.

### CSP
CSP is not enforced yet. Google auth, Socket.IO, API and image/R2 origins must first be inventoried. Introduce Content-Security-Policy-Report-Only, inspect violations, then enforce.

### Mutating GET `/picking/next-task`
It claims/releases task locks and is therefore not semantically read-only. Migrate client + server to POST, keep a short compatibility window for already-open old frontend bundles, then remove the GET alias.

### R2 object privacy
Product/search photos are intentionally public-by-URL today. If receipt/evidence media becomes privacy-sensitive, separate it into a private R2 prefix/bucket and issue authenticated signed GET URLs instead of relying on unguessable public object names.

## High-priority infrastructure actions

1. **Rotate every secret that was present in the accidentally packaged `*.env` artifact.** The v36.4 release tree excludes the file.
2. **MongoDB Atlas production:** enable continuous backup / Point-in-Time Restore if the chosen cluster tier supports it, and perform a real restore drill.
3. **MongoDB:** consider collection-level `$jsonSchema` validators for the most critical immutable/invariant fields after an audit/migration of existing documents. Mongoose validation alone does not protect direct shell/scripts.
4. **R2:** add short lifecycle expiry to ephemeral prefixes `vision-tmp/`, `missing-products/`, `price-queries/` so abandoned presigned uploads cannot accumulate forever.
5. **Cloudflare edge:** rate-limit login/registration, presign, vision/AI and other expensive endpoints. Application user-aware throttles should use shared Redis rather than process-local Maps.
6. **Cloudflare/R2:** keep public R2 traffic on a custom domain rather than treating the development `r2.dev` endpoint as production delivery.
7. **Render:** do not horizontally scale the web service without `REDIS_URL`. The current `WEB_CONCURRENCY` guard cannot detect multiple separate Render instances.
8. **Render:** use Render Key Value / Redis for Socket.IO adapter, distributed locks, shared cache and shared rate-limit counters; keep the scheduler leader lock. A dedicated background worker/cron is an optional next simplification.
9. **Render:** configure `/api/health` as the service health-check path and monitor the JSON `status`, not only HTTP reachability.
10. **Vercel:** enable Deployment Protection for preview/test deployments. Roll out CSP in Report-Only before enforcement.

## Tests added/strengthened

Server:
- `securityBoundary.test.js`
- `pickingUpcomingReadiness.contract.test.js`
- `readOnlySessionMaterialization.contract.test.js`
- `orderTaskDetachScope.contract.test.js`
- `sessionFinalSummary.contract.test.js`
- `schedulerLeader.contract.test.js`
- live `security_boundaries`
- live `final_summary_retention`

Client:
- `pickingScreenState.test.js` — deterministic render-priority matrix.
- `pickingUpcomingReadiness.contract.test.js` — loading priority, synchronous group guard, stale supplement mutations.
- `securityHeaders.contract.test.js`.

## Recommended local run

```bash
# server — fast deterministic suite
npm test
npm run test:v36.4:hardening

# targeted real-DB abuse/race suites
npm run test:live:security:preflight
npm run test:live:security
npm run test:live:race:preflight
npm run test:live:race

# complete critical live suite
npm run test:live:contracts:preflight
npm run test:live:contracts

# client
npm test
npm run build
```
