'use strict';

const { listBaseLinkerAccounts } = require('../baseLinkerAccounts');
const { listAllegroAccounts } = require('../allegroAccounts');

const LIVE = 'live';
const PLANNED = 'planned';

const PROVIDERS = Object.freeze([
  {
    id: 'baselinker',
    name: 'BaseLinker',
    type: 'aggregator',
    implementation: LIVE,
    description: 'Поточний канал замовлень, фото, ТТН, етикеток і складського picking-процесу.',
    api: [
      { id: 'orders.read', label: 'Замовлення', operation: 'getOrders', direction: 'read', implementation: LIVE },
      { id: 'orders.status.write', label: 'Статус замовлення', operation: 'setOrderStatus', direction: 'write', implementation: LIVE, note: 'Використовується лише контрольований перехід у статус Відправлено.' },
      { id: 'metadata.statuses.read', label: 'Статуси', operation: 'getOrderStatusList', direction: 'read', implementation: LIVE },
      { id: 'metadata.sources.read', label: 'Джерела замовлень', operation: 'getOrderSources', direction: 'read', implementation: LIVE },
      { id: 'catalog.inventories.read', label: 'Inventories', operation: 'getInventories', direction: 'read', implementation: LIVE },
      { id: 'catalog.products.read', label: 'Дані та фото товарів', operation: 'getInventoryProductsData', direction: 'read', implementation: LIVE },
      { id: 'shipments.packages.read', label: 'Посилки / ТТН', operation: 'getOrderPackages', direction: 'read', implementation: LIVE },
      { id: 'shipments.labels.read', label: 'Етикетка перевізника', operation: 'getLabel', direction: 'read', implementation: LIVE },
      { id: 'offers.publish', label: 'Публікація товарів', operation: 'catalog outbound', direction: 'write', implementation: PLANNED },
      { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'catalog outbound', direction: 'write', implementation: PLANNED },
      { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'catalog outbound', direction: 'write', implementation: PLANNED },
    ],
  },
  {
    id: 'allegro',
    name: 'Allegro',
    type: 'marketplace',
    implementation: LIVE,
    description: 'Пряма інтеграція без залежності від BaseLinker: OAuth, замовлення, offers, Wysyłam z Allegro та етикетки.',
    api: [
      { id: 'auth.oauth', label: 'OAuth seller account', operation: 'OAuth 2.0', direction: 'auth', implementation: LIVE },
      { id: 'orders.read', label: 'Замовлення', operation: 'order checkout forms / events', direction: 'read', implementation: LIVE, capability: 'ordersRead', scope: 'allegro:api:orders:read' },
      { id: 'orders.write', label: 'Статус/fulfillment замовлення', operation: 'order fulfillment', direction: 'write', implementation: LIVE, capability: 'ordersWrite', scope: 'allegro:api:orders:write' },
      { id: 'offers.read', label: 'Offers / фото товарів', operation: 'sale offers', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read' },
      { id: 'offers.preflight', label: 'Preflight публікації', operation: 'Commerce publication preview', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Локальна перевірка товару/акаунта без створення offer в Allegro.' },
      { id: 'shipments.read', label: 'Відправлення / ТТН', operation: 'shipment-management', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
      { id: 'shipments.write', label: 'Wysyłam z Allegro', operation: 'shipment-management', direction: 'write', implementation: LIVE, capability: 'shipmentsWrite', scope: 'allegro:api:shipments:write' },
      { id: 'shipments.labels.read', label: 'Етикетка WzA', operation: 'shipment-management/label', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
      { id: 'offers.publish', label: 'Створення offer', operation: 'POST /sale/product-offers', direction: 'write', implementation: PLANNED, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write' },
      { id: 'offers.update', label: 'Редагування offer', operation: 'PATCH /sale/product-offers/{offerId}', direction: 'write', implementation: PLANNED, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write' },
      { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'price commands', direction: 'write', implementation: PLANNED },
      { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'quantity commands', direction: 'write', implementation: PLANNED },
      { id: 'catalog.mapping', label: 'Категорії та параметри', operation: 'sale categories / parameters', direction: 'read', implementation: PLANNED },
    ],
  },
  {
    id: 'olx',
    name: 'OLX',
    type: 'marketplace',
    implementation: PLANNED,
    description: 'Майбутній marketplace adapter для оголошень, повідомлень та замовлень, якщо канал їх надає.',
    api: [
      { id: 'auth', label: 'Авторизація акаунта', operation: 'provider auth', direction: 'auth', implementation: PLANNED },
      { id: 'offers.publish', label: 'Публікація оголошень', operation: 'listing outbound', direction: 'write', implementation: PLANNED },
      { id: 'offers.update', label: 'Редагування оголошень', operation: 'listing outbound', direction: 'write', implementation: PLANNED },
      { id: 'orders.read', label: 'Замовлення', operation: 'orders inbound', direction: 'read', implementation: PLANNED },
    ],
  },
  {
    id: 'temu',
    name: 'Temu',
    type: 'marketplace',
    implementation: PLANNED,
    description: 'Майбутній marketplace adapter для каталогу, публікацій, залишків та замовлень.',
    api: [
      { id: 'auth', label: 'Авторизація seller account', operation: 'provider auth', direction: 'auth', implementation: PLANNED },
      { id: 'offers.publish', label: 'Публікація товарів', operation: 'product outbound', direction: 'write', implementation: PLANNED },
      { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'price outbound', direction: 'write', implementation: PLANNED },
      { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'inventory outbound', direction: 'write', implementation: PLANNED },
      { id: 'orders.read', label: 'Замовлення', operation: 'orders inbound', direction: 'read', implementation: PLANNED },
    ],
  },
]);

function providerStatus(provider, accounts) {
  if (provider.implementation === PLANNED) return 'planned';
  if (!accounts.length) return 'not_configured';
  if (accounts.some((account) => account.enabled === true)) return 'active';
  return 'configured_inactive';
}

function publicBaseLinkerAccounts(accounts) {
  return accounts.map((account) => ({
    accountId: String(account.accountId || ''),
    name: String(account.name || ''),
    enabled: account.enabled === true,
    queueConfigured: account.queueConfigured === true,
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt || null,
    lastSyncError: String(account.lastSyncError || ''),
    lastConnectionCheckAt: account.lastConnectionCheckAt || null,
    lastConnectionError: String(account.lastConnectionError || ''),
  }));
}

function publicAllegroAccounts(accounts) {
  return accounts.map((account) => ({
    accountId: String(account.accountId || ''),
    name: String(account.name || ''),
    enabled: account.enabled === true,
    authState: String(account.authState || 'authorization_required'),
    login: String(account.login || ''),
    scopesKnown: account.scopesKnown === true,
    scopes: Array.isArray(account.scopes) ? account.scopes : [],
    capabilities: account.capabilities || {},
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt || null,
    lastSyncError: String(account.lastSyncError || ''),
    lastConnectionCheckAt: account.lastConnectionCheckAt || null,
    lastConnectionError: String(account.lastConnectionError || ''),
  }));
}

function enrichApiCoverage(provider, accounts) {
  const activeAccounts = accounts.filter((account) => account.enabled === true);
  return provider.api.map((entry) => {
    if (entry.implementation !== LIVE) return { ...entry, availableAccounts: 0, activeAccounts: activeAccounts.length };
    if (!entry.capability) {
      return {
        ...entry,
        availableAccounts: activeAccounts.length,
        activeAccounts: activeAccounts.length,
      };
    }
    const availableAccounts = activeAccounts.filter((account) => account.capabilities?.[entry.capability] === true).length;
    return { ...entry, availableAccounts, activeAccounts: activeAccounts.length };
  });
}

async function getCommerceIntegrationRegistry() {
  // Registry is a cheap local read-model. It intentionally performs no upstream
  // BaseLinker/Allegro calls: provider schedulers/settings own those checks.
  const [baseLinkerAccountsRaw, allegroAccountsRaw] = await Promise.all([
    listBaseLinkerAccounts({ includeDisabled: true }),
    listAllegroAccounts({ includeDisabled: true }),
  ]);

  const accountMap = {
    baselinker: publicBaseLinkerAccounts(baseLinkerAccountsRaw),
    allegro: publicAllegroAccounts(allegroAccountsRaw),
    olx: [],
    temu: [],
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: PROVIDERS.map((provider) => {
      const accounts = accountMap[provider.id] || [];
      const activeAccounts = accounts.filter((account) => account.enabled === true).length;
      return {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        implementation: provider.implementation,
        description: provider.description,
        status: providerStatus(provider, accounts),
        summary: {
          totalAccounts: accounts.length,
          activeAccounts,
        },
        accounts,
        api: enrichApiCoverage(provider, accounts),
      };
    }),
  };
}

module.exports = {
  PROVIDERS,
  getCommerceIntegrationRegistry,
};
