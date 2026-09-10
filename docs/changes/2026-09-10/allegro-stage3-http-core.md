# Allegro Stage 3 — independent provider + HTTP Core

Date: 2026-09-10

## Architecture correction

Allegro is a first-class provider and no longer belongs to a BaseLinker account.

- `AllegroAccount` has its own durable UUID and no `baseLinkerAccountId` runtime field.
- Admin creates Allegro accounts through `POST /api/admin/allegro-settings/accounts`.
- Multiple Allegro seller accounts are isolated from each other and from BaseLinker.
- Any future Allegro↔BaseLinker relationship must be an explicit optional mapping model, not an identity dependency.
- An idempotent startup migration unsets the temporary Stage 1/2 `baseLinkerAccountId`; `syncIndexes()` then removes obsolete Mongo indexes. OAuth credentials, Allegro identity, enabled state and sync state are untouched.

## HTTP Core

All normal authenticated Allegro REST traffic must go through `services/allegroHttpClient.js`.

The core provides:

- app-wide rolling request budget shared by every Allegro account;
- Redis coordination across backend workers with a conservative process-local fallback;
- per-account concurrency isolation;
- optional endpoint-specific rate policies for resources with lower documented limits;
- centralized `Authorization`, `Accept`, `Accept-Language`, `Content-Type` and mandatory `User-Agent` headers;
- bounded request timeout;
- Allegro error normalization for the complete sanitized `errors[]` array (`code`, `message`, `userMessage`, `details`, `path`, `metadata`), with the first item used as the primary application error;
- response `Trace-Id` capture;
- `Retry-After` parsing;
- exactly one controlled token refresh after HTTP 401, deduplicated by token revision when several workers reject the same old token concurrently;
- safe retry policy: ordinary POST is never blindly retried, while safe/idempotent operations may retry transient failures;
- HTTP 202 represented as `pending` with `Location` and `Retry-After`, never flattened into completed success;
- sanitized TTL-retained API error diagnostics with no token or request-body storage; a second 401 marks only the Allegro account revoked and returns an application-level reauthorization error rather than invalidating the ERP user session.

## Rate-limit policy

The current documented main Allegro REST limit is 9000 requests/minute per Client ID. The internal default is intentionally lower (`8500/min`, max configurable `8950/min`) to retain headroom.

`ALLEGRO_REQUEST_BUDGET_PER_MINUTE` controls the coordinated internal app budget.

If Redis is unavailable, the core falls back to a conservative per-process budget (`ALLEGRO_LOCAL_FALLBACK_BUDGET_PER_MINUTE`, default 1000/min) and reports `coordinationMode=process_local`. Production with more than one backend worker should use Redis coordination.

Endpoint-specific limits are not guessed. A caller may supply a documented `ratePolicy` for a resource once that endpoint is implemented.

## Diagnostics

Admin-only endpoints:

- `GET /api/allegro/status`
- `GET /api/allegro/api-usage`
- `GET /api/allegro/errors`
- `POST /api/allegro/accounts/:accountId/connection-check`

`connection-check` now uses the same common HTTP Core as future order/shipment traffic.

## Environment

Optional Stage 3 tuning:

```env
ALLEGRO_REQUEST_BUDGET_PER_MINUTE=8500
ALLEGRO_ACCOUNT_MAX_CONCURRENCY=4
ALLEGRO_HTTP_TIMEOUT_MS=15000
ALLEGRO_LOCAL_FALLBACK_BUDGET_PER_MINUTE=1000
ALLEGRO_MAX_INLINE_RETRY_DELAY_MS=2500
ALLEGRO_ERROR_RETENTION_DAYS=14
```

OAuth variables from Stage 2 remain required for a connected production account.

## Deliberate boundary

Stage 3 still does not ingest orders, create shipments/labels, mutate Allegro orders, or reuse BaseLinker picking models. Those begin only after a provider-neutral Allegro order projection is defined.

## Next stage

Stage 4: direct Allegro order ingestion using the event journal, durable per-account cursor, exact order hydration, deduplication/reconciliation and a normalized internal DTO suitable for reusing warehouse UI components without coupling Allegro to BaseLinker.
