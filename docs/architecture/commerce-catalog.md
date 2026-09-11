# Commerce Catalog — Stage 2 contract

Date: 2026-09-11

## Goal

Commerce Catalog is the provider-neutral commercial product layer between the physical warehouse and marketplace listings.

It deliberately does **not** replace `Product`:

- `Product` remains the authority for physical warehouse quantity and warehouse lifecycle.
- `CommerceProduct` owns sellable content shared across channels: SKU/EAN, title, description, brand, base price, media and generic attributes.
- `ChannelListing` owns marketplace/account-specific state and overrides.

## Stock authority

`CommerceProduct` has no independent stock field. It stores `warehouseBindings` only.

For Stage 2 the catalog read model calculates available stock from linked active `Product.quantity` rows:

`floor((quantity - stockBuffer) / unitsPerItem)`

This prevents a second stock source of truth. Future reservations/channel caps belong to a stock policy layer and/or `ChannelListing`, not to a duplicated master quantity.

## Models

### CommerceProduct

Provider-neutral master data:

- `sku`, `ean`, `name`, `description`, `brand`
- `basePrice`, `currency`
- `media[]`, `attributes`
- `warehouseBindings[]`
- `status`: `draft | active | archived`
- audit/source timestamps

`warehouseBindings` are additive stock sources for the same sellable unit in Stage 2; they are **not** a bundle/BOM model. A future bundle layer must model component constraints separately.

A physical warehouse product may later participate in other commercial structures, so the database does not make `warehouseBindings.productId` globally unique. The simple one-to-one warehouse import path additionally stores a hidden `directWarehouseProductId` with a partial unique index. That makes bulk import idempotent even under concurrent clicks without preventing future non-import composition models.

### ChannelListing

One external publication/listing binding:

- `commerceProductId`
- `provider`, `accountId`, `externalId`, `externalUrl`
- channel category/attributes and title/description overrides
- price/stock policy
- publication/sync state

The model exists in Stage 2 so Stage 3 Publication Engine does not need to change the catalog data contract.

## API

- `GET /api/commerce/catalog`
- `POST /api/commerce/catalog`
- `GET /api/commerce/catalog/:id`
- `PATCH /api/commerce/catalog/:id`
- `GET /api/commerce/catalog/warehouse-products`
- `POST /api/commerce/catalog/import-warehouse`

All endpoints use the same marketplace-worker boundary as the rest of Commerce Hub (`admin` or technical `baselinker` role).

## Explicit non-goals for Stage 2

- no outbound publishing
- no remote category mapping
- no stock/price push to marketplaces
- no background sync jobs
- no migration of provider-specific BaseLinker/Allegro order indexes

Those belong to Stage 3+.
