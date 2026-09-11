# Commerce Product Master Contract v1

`CommerceProduct` is the provider-neutral canonical product owned by our Commerce Core.

## Hard boundaries

- No Allegro/OLX/Temu IDs, categories, parameters or status fields belong in `CommerceProduct`.
- Provider-specific mapping and publication state belong in `ChannelListing` / provider adapters.
- Online inventory belongs in `CommerceInventoryItem`; `Product.quantity` from the main warehouse is provenance only and is never live stock for Commerce.
- Main-warehouse copy imports catalog data only; online stock starts independently.

## Canonical product domains

- identity: `name`, `sku`, `brand`, `condition`, `language`
- identifiers: `identifiers[]` (GTIN/EAN/UPC/ISBN/ISSN/MPN/custom); legacy `ean` is compatibility only
- media: ordered `media[]`, exactly one `role=primary`, remaining `role=gallery`
- taxonomy: our own `CommerceCategory`
- attributes: provider-neutral `attributeValues[]`; legacy free-form `attributes` remains during adapter migration
- physical: weight/dimensions in canonical grams/millimetres
- pricing: `basePrice`, `currency`
- inventory: separate `CommerceInventoryItem`
- readiness: computed, provider-neutral completeness; provider adapters apply their own additional requirements

Provider adapters translate this contract into their external API contracts. Core UI must not know marketplace payload shapes.
