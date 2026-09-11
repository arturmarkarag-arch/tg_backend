# Allegro Stage 4.2 — application config back to backend env

Stage 4.1's admin-managed Allegro application credentials were intentionally reverted after live Sandbox OAuth validation.

## Final contract

Shared Allegro application configuration is deployment configuration and comes only from backend environment variables:

- `ALLEGRO_ENVIRONMENT`
- `ALLEGRO_CLIENT_ID`
- `ALLEGRO_CLIENT_SECRET`
- `ALLEGRO_REDIRECT_URI`
- `ALLEGRO_USER_AGENT`
- `ALLEGRO_TOKEN_ENCRYPTION_KEY`
- `WEB_APP_URL` remains the general backend -> frontend redirect target.

The admin UI manages seller connections only: create, OAuth connect/reconnect, connection check, enable/disable and draft deletion.

Each seller still owns its own UUID, encrypted access/refresh token pair, OAuth identity, event cursor, queues and sync state.

The temporary Stage 4.1 `AppSetting` key `allegro.oauth.config.v1` is removed at startup. This cleanup does not touch any `AllegroAccount` credentials, identity, orders or cursor state.
