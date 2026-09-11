# Allegro Stage 4.3 — live hardening

Date: 2026-09-11

## Scope

Stage 4.3 closes the remaining provider-core operational gaps before the shared warehouse workflow is introduced.

- Persist capability state derived from OAuth scopes per seller account.
- Prevent activation of a known under-scoped account when `allegro:api:orders:read` is missing.
- Expose only sanitized token rotation metadata (`tokenRevision`, expiry timestamps); token material remains server-only.
- Add an admin-only forced refresh action to live-test refresh-token rotation without returning tokens to the browser.
- Persist order scheduler cooldown in `AllegroOrderSyncState.nextRetryAt`, so a process restart does not erase provider backoff.
- Persist last sync error code, upstream HTTP status and Allegro Trace-Id.
- Compute `pending / bootstrapping / healthy / degraded / backoff / stale / error` order-sync health per account.
- Add explicit safe re-bootstrap for one selected enabled account. Existing local projection stays visible while the new authoritative SELLER snapshot is fetched; Allegro itself is never mutated by this recovery action.
- Keep all state isolated by our durable Allegro account UUID.

## Security invariants

- Application Client ID/Secret, redirect URI, User-Agent and token-encryption key remain backend env only.
- Seller access and refresh tokens remain AES-256-GCM encrypted and never enter public DTOs.
- Forced refresh returns only revision/expiry metadata.
- All diagnostic and recovery endpoints remain behind the existing admin role gate.

## Deployment

No destructive migration is required. Mongoose adds the new sync-state fields lazily. Existing accounts with older/unknown scope metadata are not bricked; re-OAuth records the exact scope set.
