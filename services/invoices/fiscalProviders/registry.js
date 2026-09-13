'use strict';

const { appError } = require('../../../utils/errors');
const ksef = require('./ksef');
const { FISCAL_PROVIDER_CONTRACT_VERSION, IMPLEMENTATION } = require('./contract');

const adapters = new Map([[ksef.id, ksef]]);

function getFiscalProviderAdapter(providerId, { requireLive = false } = {}) {
  const id = String(providerId || '').trim().toLowerCase();
  const adapter = adapters.get(id) || null;
  if (!adapter) throw appError('invoice_fiscal_provider_not_supported');
  if (requireLive && adapter.implementation !== IMPLEMENTATION.LIVE) throw appError('invoice_fiscal_provider_not_live');
  return adapter;
}

function getFiscalProviderRegistry() {
  return {
    contractVersion: FISCAL_PROVIDER_CONTRACT_VERSION,
    providers: [...adapters.values()].map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      jurisdiction: adapter.jurisdiction,
      implementation: adapter.implementation,
      description: adapter.description,
      capabilities: adapter.capabilities,
      metadata: adapter.metadata,
    })),
  };
}

module.exports = { getFiscalProviderAdapter, getFiscalProviderRegistry };
