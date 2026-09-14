'use strict';

const { appError } = require('../../../utils/errors');
const manual = require('./manual');
const warehouseOrder = require('./warehouseOrder');
const allegroOrder = require('./allegroOrder');
const baseLinkerOrder = require('./baseLinkerOrder');
const { SOURCE_PROVIDER_CONTRACT_VERSION } = require('./contract');

const adapters = new Map([
  [manual.id, manual],
  [warehouseOrder.id, warehouseOrder],
  [allegroOrder.id, allegroOrder],
  [baseLinkerOrder.id, baseLinkerOrder],
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

async function verifyInvoiceSource(invoice, context = {}) {
  const adapterId = String(invoice?.source?.metadata?.adapter || '').trim().toLowerCase();
  if (!adapterId) return { verified: true, skipped: true };
  const adapter = getInvoiceSourceAdapter(adapterId);
  if (typeof adapter.verifySource !== 'function') return { verified: true, skipped: true };
  const result = await adapter.verifySource({ invoice, context });
  const expectedSha256 = String(result?.expectedSha256 || '').trim();
  const currentSha256 = String(result?.currentSha256 || '').trim();
  if (!expectedSha256 || !currentSha256) throw appError('invoice_source_contract_invalid', { blockers: ['invoice_source_snapshot_hash_missing'] });
  if (expectedSha256 !== currentSha256) {
    throw appError('invoice_source_stale', {
      sourceProvider: String(invoice?.source?.provider || ''),
      sourceOrderId: String(invoice?.source?.entityId || ''),
    });
  }
  return { verified: true, skipped: false, currentSha256 };
}

module.exports = {
  getInvoiceSourceAdapter,
  listInvoiceSourceAdapters,
  getInvoiceSourceRegistry,
  buildInvoiceDraftFromSource,
  verifyInvoiceSource,
};
