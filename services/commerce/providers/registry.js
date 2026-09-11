'use strict';

const { appError } = require('../../../utils/errors');
const { PROVIDER_CONTRACT_VERSION, IMPLEMENTATION, CAPABILITIES } = require('./contract');
const allegro = require('./allegro');
const { olx, temu } = require('./planned');

const adapters = new Map([
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
    capabilities: adapter.capabilities,
    metadata: adapter.metadata,
    selectableForPublication: adapter.implementation === IMPLEMENTATION.LIVE && providerSupports(adapter, CAPABILITIES.LISTING_PREVIEW),
    summary: {
      totalAccounts: accounts.length,
      activeAccounts,
      publicationAccounts,
    },
    accounts,
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
  executeProviderOperation,
};
