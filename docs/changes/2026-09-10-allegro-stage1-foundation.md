# Allegro Stage 1 — account mapping and admin surface

Date: 2026-09-10

## Scope

This stage intentionally does **not** talk to Allegro yet. It establishes the durable local model and admin API needed before OAuth and order synchronization exist.

- New `AllegroAccount` model with our own UUID.
- Many Allegro accounts may reference one `BaseLinkerAccount` through `baseLinkerAccountId`.
- Allegro account drafts start as `authorization_required` and disabled.
- No OAuth token is accepted from the browser or stored in Stage 1.
- `/api/admin/allegro-settings` exposes only public account metadata and OAuth configuration flags.
- `/api/admin/baselinker-settings/accounts/:baseLinkerAccountId/allegro-accounts` creates a linked draft.
- `/api/allegro/status` is admin-only and performs no upstream I/O.

## Deliberate boundary

The BaseLinker relation is a business mapping owned by this ERP. Allegro does not know about BaseLinker. Order status semantics must therefore not be copied from BaseLinker status IDs; later stages will normalize both providers into one internal workflow.

## Next stage

OAuth authorization-code flow, encrypted access/refresh token storage, refresh locking/rotation, profile identity validation, scopes and connection diagnostics.
