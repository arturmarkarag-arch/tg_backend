'use strict';

const { appError } = require('../../../utils/errors');
const manual = require('./manual');
const warehouseOrder = require('./warehouseOrder');
const { SOURCE_PROVIDER_CONTRACT_VERSION } = require('./contract');

const adapters = new Map([
  [manual.id, manual],
  [warehouseOrder.id, warehouseOrder],
]);

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase();
}

function getInvoiceSourceAdapter(providerId) {
  const adapter = adapters.get(normalizeProviderId(providerId)) || null;
  if (!adapter) throw appError('invoice_source_provider_not_supported');
  return adapter;
}

function listInvoiceSourceAdapters() {
  return [...adapters.values()];
}

function getInvoiceSourceRegistry() {
  return {
    contractVersion: SOURCE_PROVIDER_CONTRACT_VERSION,
    providers: listInvoiceSourceAdapters().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      entityTypes: adapter.entityTypes,
      description: adapter.description,
      metadata: adapter.metadata,
    })),
  };
}

async function buildInvoiceDraftFromSource(providerId, request = {}) {
  const adapter = getInvoiceSourceAdapter(providerId);
  return adapter.buildDraft(request);
}

module.exports = {
  getInvoiceSourceAdapter,
  listInvoiceSourceAdapters,
  getInvoiceSourceRegistry,
  buildInvoiceDraftFromSource,
};
