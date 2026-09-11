# Commerce Hub — Stage 1 foundation

## Goal

Commerce Hub is the provider-neutral surface for internet-store/marketplace work.
BaseLinker and Allegro are adapters, not the application architecture. Future
providers (OLX, Temu, etc.) must plug into the same domain instead of creating a
new top-level application section for every API.

## Stage 1 contract

- `GET /api/commerce/integrations` is the source of truth for the integration/API registry shown in the UI.
- The registry is a **local read-model** only: it reads configured account metadata from MongoDB and performs no upstream marketplace calls.
- Role `baselinker` is retained as a technical role name for compatibility, but its operational boundary is the commerce domain: `/api/commerce`, `/api/baselinker`, `/api/allegro`.
- Provider settings, secrets, OAuth administration and diagnostics remain protected by their existing admin-only endpoint guards.
- Existing BaseLinker and Allegro order workflows remain unchanged and provider-isolated.

## UI structure

`Інтернет-магазини` is one application page with internal sections:

1. `Замовлення` — current provider-specific order workflows, initially BaseLinker and Allegro.
2. `Товари` — reserved for the future provider-neutral Commerce Catalog.
3. `Публікації` — reserved for PublicationBatch/PublicationJob outbound orchestration.
4. `Інтеграції` — provider/account status plus API coverage registry.

## Next domain layers

The next stages should add, in this order:

- `CommerceProduct`: provider-neutral sellable catalog item linked to warehouse stock/products.
- `ChannelListing`: one publication of one CommerceProduct in one provider account.
- `PublicationBatch` + `PublicationJob`: queued bulk publishing/sync with retry, validation and audit.
- Provider adapter contract (`orders`, `catalog`, `listing`, `price`, `stock`, `shipment`) implemented independently by Allegro/OLX/Temu/etc.

Warehouse `Product` remains a physical/logistics entity and must not accumulate marketplace-specific offer fields.
