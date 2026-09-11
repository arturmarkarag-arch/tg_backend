# Commerce Provider Core v1

## Invariant

`CommerceProduct`, `CommerceInventoryItem`, reservations and movements are canonical application data. They must not contain Allegro/OLX/Temu field names or API payloads.

A provider adapter translates canonical data to one external channel. Adding a provider must not require `if (provider === ...)` branches in Commerce Core pages/services.

## Durable boundaries

- `CommerceProduct`: canonical product identity/content/attributes.
- `CommerceInventoryItem`: internet-store stock only. Main warehouse `Product.quantity` is a separate domain.
- `ChannelListing`: one product × provider × account, generic overrides and opaque adapter state in `providerData[provider]`.
- `CommercePublicationJob`: provider-neutral durable operation/idempotency state.
- Provider adapter: account normalization, provider readiness/preflight, taxonomy/mapping, API translation and provider operations.

## Provider contract v1

Every live adapter declares:

- stable `id`, `name`, `type`, `implementation`;
- capabilities;
- account loader + public account normalization;
- publication preview context + row validation;
- named operations (`mapping.resolve`, `draft.create`, `price.apply`, etc.) with kind and capability;
- API coverage metadata for Integration Registry.

The Provider Core exposes one generic dispatch surface:

`POST /api/commerce/providers/:provider/operations/:operation`

Provider-specific legacy routes may remain as compatibility aliases, but new providers must not require new Commerce Core route trees.

## Frontend boundary

`CommercePublications.jsx` selects canonical products and `{provider, accountId}` targets only. Provider-specific UI is registered under `features/commerce/providers/` and is not imported directly by the core page.

## Rules for new providers

1. Do not add provider fields to `CommerceProduct`.
2. Do not read or write another provider's `providerData` namespace.
3. Do not use main warehouse `Product.quantity` as Commerce stock.
4. Declare capabilities instead of branching on provider id in core code.
5. Network writes must be durable/idempotent through `CommercePublicationJob` or an equivalent provider-neutral job boundary.
6. Dynamic category/attribute requirements belong to adapter mapping/readiness, not canonical product schema.
7. External API responses must be normalized before they reach provider-neutral UI/state.
