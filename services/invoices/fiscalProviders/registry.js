'use strict';

const { appError } = require('../../../utils/errors');
const ksef = require('./ksef');
const { FISCAL_PROVIDER_CONTRACT_VERSION, IMPLEMENTATION } = require('./contract');

const providers = new Map([[ksef.id, ksef]]);

function getFiscalProvider(providerId, { requireLive = false } = {}) {
  const id = String(providerId || '').trim().toLowerCase();
  const provider = providers.get(id) || null;
  if (!provider) throw appError('invoice_fiscal_provider_not_supported');
  if (requireLive && provider.implementation !== IMPLEMENTATION.LIVE) throw appError('invoice_fiscal_provider_not_live');
  return provider;
}

function getFiscalProviderRegistry() {
  return {
    contractVersion: FISCAL_PROVIDER_CONTRACT_VERSION,
    providers: [...providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      jurisdiction: provider.jurisdiction,
      implementation: provider.implementation,
      description: provider.description,
      capabilities: provider.capabilities,
      metadata: provider.metadata,
    })),
  };
}

module.exports = {
  getFiscalProvider,
  getFiscalProviderRegistry,
  getFiscalProviderAdapter: getFiscalProvider,
};
