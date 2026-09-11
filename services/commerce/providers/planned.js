'use strict';

const {
  CAPABILITIES,
  IMPLEMENTATION,
  PROVIDER_TYPES,
  createProviderAdapter,
} = require('./contract');

function plannedMarketplace({ id, name, description, metadata = {}, integrationApi = [] }) {
  return createProviderAdapter({
    id,
    name,
    type: PROVIDER_TYPES.MARKETPLACE,
    implementation: IMPLEMENTATION.PLANNED,
    description,
    capabilities: {
      [CAPABILITIES.ACCOUNTS]: false,
      [CAPABILITIES.ORDERS_READ]: false,
      [CAPABILITIES.PRODUCT_MAPPING]: false,
      [CAPABILITIES.LISTING_PREVIEW]: false,
      [CAPABILITIES.LISTING_CREATE]: false,
      [CAPABILITIES.LISTING_UPDATE_CONTENT]: false,
      [CAPABILITIES.PRICE_SYNC]: false,
      [CAPABILITIES.STOCK_SYNC]: false,
      [CAPABILITIES.LIFECYCLE]: false,
      [CAPABILITIES.HEALTH]: false,
    },
    metadata,
    integrationApi,
  });
}

const olx = plannedMarketplace({
  id: 'olx',
  name: 'OLX',
  description: 'Майбутній adapter OLX Partner API. Commerce Core не залежить від структури OLX advert/category/attributes.',
  metadata: {
    productModel: 'advert',
    taxonomy: 'provider_owned',
    externalIdSupported: true,
  },
  integrationApi: [
    { id: 'auth', label: 'Авторизація акаунта', operation: 'OAuth2', direction: 'auth', implementation: 'planned' },
    { id: 'catalog.categories.read', label: 'Категорії', operation: 'GET /categories', direction: 'read', implementation: 'planned' },
    { id: 'catalog.attributes.read', label: 'Атрибути категорії', operation: 'GET /categories/{id}/attributes', direction: 'read', implementation: 'planned' },
    { id: 'offers.publish', label: 'Публікація оголошень', operation: 'POST /adverts', direction: 'write', implementation: 'planned' },
    { id: 'offers.update', label: 'Редагування оголошень', operation: 'advert outbound', direction: 'write', implementation: 'planned' },
    { id: 'orders.read', label: 'Замовлення / delivery flow', operation: 'provider-specific inbound', direction: 'read', implementation: 'planned' },
  ],
});

const temu = plannedMarketplace({
  id: 'temu',
  name: 'Temu',
  description: 'Майбутній seller adapter Temu. Product/category/attribute contracts будуть транслюватися з canonical Commerce Product через adapter.',
  metadata: {
    productModel: 'seller_product',
    taxonomy: 'provider_owned',
  },
  integrationApi: [
    { id: 'auth', label: 'Авторизація seller account', operation: 'provider auth', direction: 'auth', implementation: 'planned' },
    { id: 'catalog.mapping', label: 'Категорії та атрибути', operation: 'provider taxonomy', direction: 'read', implementation: 'planned' },
    { id: 'offers.publish', label: 'Публікація товарів', operation: 'product outbound', direction: 'write', implementation: 'planned' },
    { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'price outbound', direction: 'write', implementation: 'planned' },
    { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'inventory outbound', direction: 'write', implementation: 'planned' },
    { id: 'orders.read', label: 'Замовлення', operation: 'orders inbound', direction: 'read', implementation: 'planned' },
  ],
});

module.exports = { olx, temu };
