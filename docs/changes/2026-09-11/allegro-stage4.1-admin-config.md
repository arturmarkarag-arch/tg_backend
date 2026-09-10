# Allegro Stage 4.1 — admin-managed application configuration

## Goal
Move Allegro application OAuth configuration out of mandatory provider-specific deployment env variables and into the admin settings UI, while keeping secrets server-only and encrypted at rest.

## Runtime contract
- `environment`, `clientId`, `redirectUri`, and `userAgent` are persisted in `AppSetting(allegro.oauth.config.v1)`.
- `clientSecret` and the Allegro token-encryption key are persisted only as AES-256-GCM encrypted blobs.
- The encryption root is `APP_SETTINGS_ENCRYPTION_KEY` when configured; otherwise the already-required `JWT_SECRET` is used through a purpose-separated SHA-256 derivation.
- GET/admin DTOs expose only `*Configured` flags for secret fields, never secret values.
- Existing complete legacy `ALLEGRO_*` OAuth env configuration is migrated once at startup when no DB configuration exists. After verifying the DB-managed configuration, those legacy Allegro OAuth env variables may be removed.
- `ALLEGRO_OAUTH_SCOPES` remains an internal/default capability policy; `WEB_APP_URL` remains application routing configuration, not a seller credential.
- Low-level rate/poll tuning env variables remain server operational knobs and are not part of the OAuth application form.

## Safety guards
Once any Allegro seller has durable identity/tokens, changing environment, Client ID, or the token encryption key is blocked. Those changes require a controlled migration. Client Secret, Redirect URI, and User-Agent may be updated independently.

## OAuth diagnostic
Allegro documents the generic `Nie możemy wyświetlić strony` error shown while requesting the authorization code as a redirect URI mismatch. The admin UI now displays the exact Redirect URI and offers a copy action so the value can be pasted verbatim into the matching Sandbox/Production Developer Apps registration.
