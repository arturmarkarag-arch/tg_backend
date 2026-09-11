# Commerce Hub — provider-neutral commerce architecture

## Goal

Commerce Hub is the provider-neutral surface for internet-store/marketplace work.
BaseLinker and Allegro are adapters, not the application architecture. Future
providers (OLX, Temu, etc.) plug into the same domain instead of creating a new
top-level application section for every API.

## Stage 1 — Integration Hub ✅

- `GET /api/commerce/integrations` is the source of truth for the integration/API registry shown in the UI.
- The registry is a **local read-model** only: it reads configured account metadata from MongoDB and performs no upstream marketplace calls.
- Role `baselinker` is retained as a technical role name for compatibility, but its operational boundary is the commerce domain: `/api/commerce`, `/api/baselinker`, `/api/allegro`.
- Provider settings, secrets, OAuth administration and diagnostics remain protected by their existing admin-only endpoint guards.
- Existing BaseLinker and Allegro order workflows remain unchanged and provider-isolated.

## Stage 2 — Commerce Catalog ✅

- `CommerceProduct` is the provider-neutral sellable master item.
- Physical `Product` remains the authority for warehouse quantity/lifecycle.
- `CommerceProduct.warehouseBindings` link commercial items to physical stock without copying stock into the catalog.
- `ChannelListing` is a separate provider/account-specific publication model prepared for Stage 3.
- The `Товари` tab is a real catalog UI with search/filter, manual create/edit and idempotent import from active warehouse products.
- Stage 2 performs **no outbound marketplace publication or sync**.

See `docs/architecture/commerce-catalog.md` for the detailed data contract.

## UI structure

`Інтернет-магазини` is one application page with internal sections:

1. `Замовлення` — current provider-specific order workflows, initially BaseLinker and Allegro.
2. `Товари` — provider-neutral Commerce Catalog.
3. `Публікації` — reserved for PublicationBatch/PublicationJob outbound orchestration.
4. `Інтеграції` — provider/account status plus API coverage registry.

## Next domain layers

The next stages should add, in this order:

- `PublicationBatch` + `PublicationJob`: queued bulk publishing/sync with retry, validation and audit.
- provider adapter contract (`catalog`, `listing`, `price`, `stock`) implemented first for Allegro, then OLX/Temu/etc.
- channel validation/category mapping before a job may publish.
- stock/price synchronization policies with the ERP remaining authoritative for physical stock.

Warehouse `Product` must not accumulate marketplace-specific offer fields.
