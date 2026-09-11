'use strict';

const { listBaseLinkerAccounts } = require('../baseLinkerAccounts');
const { listProviderAdapters, publicProviderDescriptor } = require('./providers/registry');

const LIVE = 'live';
const PLANNED = 'planned';

const BASELINKER = Object.freeze({
  id: 'baselinker',
  name: 'BaseLinker',
  type: 'aggregator',
  implementation: LIVE,
  description: 'Поточний агрегатор замовлень/фото/ТТН/етикеток. Не є Commerce Product provider adapter і не визначає canonical product model.',
  api: [
    { id: 'orders.read', label: 'Замовлення', operation: 'getOrders', direction: 'read', implementation: LIVE },
    { id: 'orders.status.write', label: 'Статус замовлення', operation: 'setOrderStatus', direction: 'write', implementation: LIVE },
    { id: 'metadata.statuses.read', label: 'Статуси', operation: 'getOrderStatusList', direction: 'read', implementation: LIVE },
    { id: 'metadata.sources.read', label: 'Джерела замовлень', operation: 'getOrderSources', direction: 'read', implementation: LIVE },
    { id: 'catalog.inventories.read', label: 'Inventories', operation: 'getInventories', direction: 'read', implementation: LIVE },
    { id: 'catalog.products.read', label: 'Дані та фото товарів', operation: 'getInventoryProductsData', direction: 'read', implementation: LIVE },
    { id: 'shipments.packages.read', label: 'Посилки / ТТН', operation: 'getOrderPackages', direction: 'read', implementation: LIVE },
    { id: 'shipments.labels.read', label: 'Етикетка перевізника', operation: 'getLabel', direction: 'read', implementation: LIVE },
    { id: 'offers.publish', label: 'Публікація товарів', operation: 'Commerce Provider adapter required', direction: 'write', implementation: PLANNED, note: 'Не додаємо outbound через BaseLinker в Core автоматично; це буде окремий adapter, якщо він реально знадобиться.' },
  ],
});

function providerStatus(implementation, accounts) {
  if (implementation === PLANNED) return 'planned';
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

function enrichApiCoverage(api, accounts) {
  const activeAccounts = accounts.filter((account) => account.enabled === true);
  return api.map((entry) => {
    if (entry.implementation !== LIVE) return { ...entry, availableAccounts: 0, activeAccounts: activeAccounts.length };
    if (!entry.capability) return { ...entry, availableAccounts: activeAccounts.length, activeAccounts: activeAccounts.length };
    const availableAccounts = activeAccounts.filter((account) => account.capabilities?.[entry.capability] === true).length;
    return { ...entry, availableAccounts, activeAccounts: activeAccounts.length };
  });
}

async function getCommerceIntegrationRegistry() {
  // Cheap local read-model: no provider network calls. Account/configuration services
  // own connectivity checks. Provider-specific API coverage comes from adapter metadata.
  const [baseLinkerRaw, providerDescriptors] = await Promise.all([
    listBaseLinkerAccounts({ includeDisabled: true }),
    Promise.all(listProviderAdapters().map((adapter) => publicProviderDescriptor(adapter))),
  ]);

  const baseLinkerAccounts = publicBaseLinkerAccounts(baseLinkerRaw);
  const providers = [{
    ...BASELINKER,
    status: providerStatus(BASELINKER.implementation, baseLinkerAccounts),
    summary: {
      totalAccounts: baseLinkerAccounts.length,
      activeAccounts: baseLinkerAccounts.filter((account) => account.enabled === true).length,
    },
    accounts: baseLinkerAccounts,
    api: enrichApiCoverage(BASELINKER.api, baseLinkerAccounts),
    commerceProvider: false,
  }];

  for (const descriptor of providerDescriptors) {
    const adapter = listProviderAdapters().find((item) => item.id === descriptor.id);
    const api = adapter?.integrationApi || [];
    providers.push({
      id: descriptor.id,
      name: descriptor.name,
      type: descriptor.type,
      implementation: descriptor.implementation,
      description: descriptor.description,
      status: providerStatus(descriptor.implementation, descriptor.accounts || []),
      summary: descriptor.summary,
      accounts: descriptor.accounts || [],
      capabilities: descriptor.capabilities || {},
      contractVersion: descriptor.contractVersion,
      commerceProvider: true,
      selectableForPublication: descriptor.selectableForPublication === true,
      api: enrichApiCoverage(api, descriptor.accounts || []),
    });
  }

  return {
    version: 12,
    providerContractVersion: 1,
    generatedAt: new Date().toISOString(),
    providers,
  };
}

module.exports = {
  BASELINKER,
  getCommerceIntegrationRegistry,
};
