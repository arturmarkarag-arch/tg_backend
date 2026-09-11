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
      { id: 'offers.preflight', label: 'Preflight публікації', operation: 'Commerce publication preview', direction: 'read', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Локальна перевірка товару/акаунта без створення offer в Allegro.' },
      { id: 'catalog.products.search', label: 'Пошук товару в Каталозі Allegro', operation: 'GET /sale/products', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read' },
      { id: 'catalog.mapping', label: 'Категорії та параметри', operation: 'GET /sale/matching-categories + /sale/categories/{id}/parameters', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3B: mapping зберігається локально в ChannelListing; offer в Allegro ще не створюється.' },
      { id: 'shipments.read', label: 'Відправлення / ТТН', operation: 'shipment-management', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
      { id: 'shipments.write', label: 'Wysyłam z Allegro', operation: 'shipment-management', direction: 'write', implementation: LIVE, capability: 'shipmentsWrite', scope: 'allegro:api:shipments:write' },
      { id: 'shipments.labels.read', label: 'Етикетка WzA', operation: 'shipment-management/label', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
      { id: 'offers.draft.create', label: 'Створення draft offer', operation: 'POST /sale/product-offers (INACTIVE)', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3C: idempotent/recoverable create через стабільний external.id; ACTIVE не вмикається.' },
      { id: 'offers.draft.reconcile', label: 'Звірка draft offer', operation: 'GET /sale/product-offers/{offerId}', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.1: read-back фактичного draft, drift detection та readiness перед налаштуваннями публікації.' },
      { id: 'offers.sales-settings.read', label: 'Sales Settings для offer', operation: 'GET /sale/shipping-rates + after-sales-service-conditions', direction: 'read', implementation: LIVE, capability: 'saleSettingsRead', scope: 'allegro:api:sale:settings:read', note: 'Stage 3D.2: cennik dostawy, zwroty, reklamacje, gwarancja, handlingTime і location. Вибір зберігається локально; upstream write = 0.' },
      { id: 'offers.sales-settings.apply', label: 'Застосування Sales Settings', operation: 'PATCH /sale/product-offers/{offerId}', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.2.1: застосовує delivery/afterSalesServices/location до INACTIVE draft, підтримує 200/202, operation polling і read-back verification.' },
      { id: 'offers.publish', label: 'Активація offer', operation: 'PATCH /sale/product-offers/{offerId} publication.status=ACTIVE', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.3: окремого Allegro publish endpoint не використовуємо; мінімальний PATCH тільки publication.status=ACTIVE, durable operation polling/read-back і final activation gate.' },
      { id: 'offers.update.preview', label: 'Preview змін ACTIVE offer', operation: 'GET /sale/product-offers/{offerId} + local diff', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.4A: read-only diff контенту. Price/stock відкладені до окремих sync stages; category/product remap не виконується автоматично.' },
      { id: 'offers.update', label: 'Редагування контенту offer', operation: 'PATCH /sale/product-offers/{offerId}', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.4.1: застосовує лише safe contentPatch (name/description/images) з fresh preview; price/stock/category/product.id не змішуємо. 200/202, recovery і read-back verification.' },
      { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'POST /sale/offer-bulk-modification-commands + GET summary/tasks', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.5: актуальний Allegro bulk contract для різних FIXED prices; максимум 25 modifications/command. Ресурс Allegro досі позначений beta. Якщо offer має price automation rule, власна ціна вимикає rule — потрібне явне підтвердження оператора.' },
      { id: 'offers.stock.preview', label: 'Preview залишку', operation: 'GET /sale/offers by external.id + Commerce Inventory/reservation policy', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.6B.2: окремий Commerce Inventory onHand мінус provider-neutral Commerce reservations, далі channel buffer/cap. Основний склад Product.quantity не використовується як online stock. stock=0 завершує ACTIVE offer; ENDED не відновлюється простим збільшенням stock.' },
      { id: 'inventory.reservations', label: 'Central reservation ledger', operation: 'local Allegro/BaseLinker order projections → CommerceStockReservation', direction: 'internal', implementation: LIVE, note: 'Stage 3D.6B: дедуплікація Allegro direct + BaseLinker bridge, exact offer/SKU/EAN mapping та fail-closed unknown holds. Buyer/address/payment дані не зберігаються.' },
      { id: 'inventory.movements', label: 'Commerce Inventory movements', operation: 'consumed reservation → exactly-once onHand movement', direction: 'internal', implementation: LIVE, note: 'Stage 3D.6B.2: shipped order списується тільки з окремого CommerceInventoryItem.onHand у Mongo transaction. Після applied movement reservation перестає додатково утримувати stock. Основний Product.quantity не змінюється.' },
      { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'POST /sale/offer-bulk-modification-commands (stock)', direction: 'write', implementation: PLANNED, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Reservation ledger уже LIVE. Commerce Inventory reservation + movement contracts уже LIVE. Write лишається PLANNED до Stage 3D.6C bulk apply/recovery; основний склад Product.quantity не змінюємо і не читаємо як source of truth.' },
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
    version: 9,
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
