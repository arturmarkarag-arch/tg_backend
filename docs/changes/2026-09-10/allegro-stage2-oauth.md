# Allegro Stage 2 — OAuth/account lifecycle

Date: 2026-09-10

> **Architecture note (Stage 3):** the temporary Stage 1/2 BaseLinker parent/mapping described below has been superseded. Allegro is now an independent provider with standalone accounts. See `2026-09-10/allegro-stage3-http-core.md`.


## Scope

This stage adds a real OAuth lifecycle for the Allegro child accounts introduced in Stage 1. It intentionally does **not** implement order ingestion, event journal processing, shipment creation, labels, TTN synchronization, or warehouse picking yet.

## Runtime flow

1. Admin creates an Allegro child under a BaseLinker account.
2. Frontend calls `POST /api/allegro/accounts/:accountId/oauth/start`.
3. Backend creates a random one-time `state`, persists only its SHA-256 digest with TTL, and returns the Allegro authorize URL.
4. Browser authorizes on Allegro and returns directly to `GET /api/allegro/oauth/callback`.
5. Callback atomically consumes the state and immediately exchanges the short-lived authorization code for an access/refresh pair.
6. Backend calls `GET /me` and permanently binds our Allegro account UUID to the real Allegro user id/login.
7. Access/refresh tokens are encrypted server-side with AES-256-GCM and are never returned to the browser.
8. Account remains disabled until an admin explicitly enables it after the connection is verified.

## Security / consistency contract

- The OAuth callback is the only public Allegro API path; all operational/configuration routes remain admin-only.
- Raw OAuth `state` is never persisted; only its SHA-256 digest is stored and it is one-time consumed.
- Access and refresh tokens use separate AAD values (`<accountId>:access`, `<accountId>:refresh`) so ciphertext cannot be swapped between token kinds or accounts.
- Token fields are `select:false` in Mongo.
- Browser CRUD endpoints never accept access tokens, refresh tokens, client id or client secret.
- Refresh is serialized by the existing distributed lock infrastructure and guarded by `tokenRevision` compare-and-swap.
- A connected internal UUID cannot silently change to a different real Allegro user id during reauthorization.
- The same real Allegro user id cannot be connected to two internal Allegro account records.
- Failed reauthorization does not destroy an already working connection.

## Required production environment

```env
ALLEGRO_ENVIRONMENT=production
ALLEGRO_CLIENT_ID=<registered Allegro application client id>
ALLEGRO_CLIENT_SECRET=<registered Allegro application client secret>
ALLEGRO_REDIRECT_URI=https://<backend-host>/api/allegro/oauth/callback
ALLEGRO_USER_AGENT=<registered application identifier/version>
ALLEGRO_TOKEN_ENCRYPTION_KEY=<dedicated long random secret>
WEB_APP_URL=https://<frontend-host>/
```

Optional override (defaults already cover the planned direct-orders + shipment workflow):

```env
ALLEGRO_OAUTH_SCOPES="allegro:api:profile:read allegro:api:orders:read allegro:api:orders:write allegro:api:shipments:read allegro:api:shipments:write"
```

`ALLEGRO_TOKEN_ENCRYPTION_KEY` must be stored in the deployment secret manager. Do not reuse or expose it in frontend/Vite variables. Changing it after accounts are connected makes the existing encrypted token blobs unreadable, so key rotation must be an explicit migration rather than a simple env replacement.

The redirect URI in Allegro Developer Apps must exactly match `ALLEGRO_REDIRECT_URI`.

## New backend surface

- `GET /api/allegro/oauth/callback` — public OAuth return path, protected by one-time state.
- `POST /api/allegro/accounts/:accountId/oauth/start` — admin-only authorize start.
- `POST /api/allegro/accounts/:accountId/connection-check` — admin-only identity/token verification.
- `GET /api/allegro/status` — admin-only Stage 2 status with public configuration flags only.

## Tests

- `npm run test:allegro:stage1`
- `npm run test:allegro:stage2`
- Existing BaseLinker multi-account/lifecycle/request-efficiency/central-polling/collision static contracts remain required regression gates.

## Next stage

Stage 3 should build the shared Allegro transport layer before orders are enabled: normalized Allegro errors + `Trace-Id`, request metering, endpoint/account throttling, `429`/`Retry-After`, retry/idempotency policy, and common authenticated request helper. Only after this foundation should Stage 4 add `/order/events` and the durable direct-order projection.
