'use strict';

const { appError } = require('../../../utils/errors');
const { PROVIDER_CONTRACT_VERSION, IMPLEMENTATION, CAPABILITIES } = require('./contract');
const baseLinker = require('./baseLinker');
const allegro = require('./allegro');
const { olx, temu } = require('./planned');

const adapters = new Map([
  [baseLinker.id, baseLinker],
  [allegro.id, allegro],
  [olx.id, olx],
  [temu.id, temu],
]);

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase();
}

function getProviderAdapter(providerId, { requireLive = false } = {}) {
  const id = normalizeProviderId(providerId);
  const adapter = adapters.get(id) || null;
  if (!adapter) throw appError('commerce_provider_not_supported');
  if (requireLive && adapter.implementation !== IMPLEMENTATION.LIVE) throw appError('commerce_provider_not_live');
  return adapter;
}

function listProviderAdapters() {
  return [...adapters.values()];
}

function providerSupports(adapter, capability) {
  return adapter?.capabilities?.[capability] === true;
}

function providerStatus(adapter, accounts) {
  if (adapter.implementation !== IMPLEMENTATION.LIVE) return 'planned';
  if (!accounts.length) return 'not_configured';
  if (accounts.some((account) => account.enabled === true)) return 'active';
  return 'configured_inactive';
}

function integrationCoverage(adapter, accounts) {
  const activeAccounts = accounts.filter((account) => account.enabled === true);
  return (adapter.integrationApi || []).map((entry) => {
    if (entry.implementation !== IMPLEMENTATION.LIVE) {
      return { ...entry, availableAccounts: 0, activeAccounts: activeAccounts.length };
    }
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

async function publicProviderDescriptor(adapter, { includeAccounts = true } = {}) {
  const rawAccounts = includeAccounts && adapter.implementation === IMPLEMENTATION.LIVE
    ? await adapter.listAccounts({ includeDisabled: true })
    : [];
  const accounts = rawAccounts.map((account) => adapter.publicAccount(account));
  const activeAccounts = accounts.filter((account) => account.enabled === true).length;
  const publicationAccounts = accounts.filter((account) => account.publicationReady === true).length;
  return {
    contractVersion: PROVIDER_CONTRACT_VERSION,
    id: adapter.id,
    name: adapter.name,
    type: adapter.type,
    implementation: adapter.implementation,
    description: adapter.description,
    status: providerStatus(adapter, accounts),
    capabilities: adapter.capabilities,
    metadata: adapter.metadata,
    selectableForPublication: adapter.implementation === IMPLEMENTATION.LIVE && providerSupports(adapter, CAPABILITIES.LISTING_PREVIEW),
    summary: {
      totalAccounts: accounts.length,
      activeAccounts,
      publicationAccounts,
    },
    accounts,
    api: integrationCoverage(adapter, accounts),
    operations: Object.values(adapter.operations).map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      capability: operation.capability,
      description: operation.description,
    })),
  };
}

async function getCommerceProviderRegistry() {
  const providers = await Promise.all(listProviderAdapters().map((adapter) => publicProviderDescriptor(adapter)));
  return {
    contractVersion: PROVIDER_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    providers,
  };
}

async function getCommerceIntegrationRegistry() {
  const registry = await getCommerceProviderRegistry();
  return {
    version: 12,
    contractVersion: registry.contractVersion,
    generatedAt: registry.generatedAt,
    providers: registry.providers,
  };
}

async function executeProviderOperation(providerId, operationId, payload = {}) {
  const adapter = getProviderAdapter(providerId, { requireLive: true });
  const operation = adapter.operations[String(operationId || '').trim()] || null;
  if (!operation) throw appError('commerce_provider_operation_not_supported');
  if (operation.capability && !providerSupports(adapter, operation.capability)) throw appError('commerce_provider_capability_not_supported');
  const result = await operation.execute(payload || {});
  const status = Number(operation.httpStatus(result));
  return {
    adapter,
    operation,
    result,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200,
  };
}

module.exports = {
  getProviderAdapter,
  listProviderAdapters,
  providerSupports,
  publicProviderDescriptor,
  getCommerceProviderRegistry,
  getCommerceIntegrationRegistry,
  executeProviderOperation,
};
