'use strict';

const FISCAL_PROVIDER_CONTRACT_VERSION = 1;
const IMPLEMENTATION = Object.freeze({ LIVE: 'live', PLANNED: 'planned' });
const CAPABILITIES = Object.freeze({
  VALIDATE: 'invoice.validate',
  SUBMIT: 'invoice.submit',
  STATUS: 'invoice.status',
  RECONCILE: 'invoice.reconcile',
  RECEIVE: 'invoice.receive',
  OFFLINE: 'invoice.offline',
  UPO: 'invoice.upo',
});

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function createFiscalProviderAdapter(definition = {}) {
  const id = text(definition.id, 80).toLowerCase();
  const name = text(definition.name, 160);
  const jurisdiction = text(definition.jurisdiction, 20).toUpperCase();
  const implementation = text(definition.implementation, 40).toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new TypeError('Fiscal provider id is invalid');
  if (!name) throw new TypeError(`Fiscal provider ${id} requires name`);
  if (!jurisdiction) throw new TypeError(`Fiscal provider ${id} requires jurisdiction`);
  if (!Object.values(IMPLEMENTATION).includes(implementation)) throw new TypeError(`Fiscal provider ${id} has invalid implementation`);

  const capabilities = Object.freeze(Object.fromEntries(
    Object.entries(definition.capabilities || {}).map(([key, value]) => [text(key, 120), value === true]),
  ));

  if (implementation === IMPLEMENTATION.LIVE) {
    for (const method of ['validate', 'submit', 'getStatus', 'reconcile']) {
      if (typeof definition[method] !== 'function') throw new TypeError(`Live fiscal provider ${id} must implement ${method}()`);
    }
    if (capabilities[CAPABILITIES.OFFLINE] && typeof definition.prepareOffline !== 'function') {
      throw new TypeError(`Fiscal provider ${id} with OFFLINE capability must implement prepareOffline()`);
    }
    if (capabilities[CAPABILITIES.UPO] && typeof definition.getUpo !== 'function') {
      throw new TypeError(`Fiscal provider ${id} with UPO capability must implement getUpo()`);
    }
    if (capabilities[CAPABILITIES.RECEIVE] && typeof definition.receive !== 'function') {
      throw new TypeError(`Fiscal provider ${id} with RECEIVE capability must implement receive()`);
    }
  }

  return Object.freeze({
    contractVersion: FISCAL_PROVIDER_CONTRACT_VERSION,
    id,
    name,
    jurisdiction,
    implementation,
    description: text(definition.description, 1000),
    capabilities,
    validate: definition.validate || null,
    submit: definition.submit || null,
    getStatus: definition.getStatus || null,
    reconcile: definition.reconcile || null,
    prepareOffline: definition.prepareOffline || null,
    getUpo: definition.getUpo || null,
    receive: definition.receive || null,
    metadata: Object.freeze({ ...(definition.metadata || {}) }),
  });
}

module.exports = {
  FISCAL_PROVIDER_CONTRACT_VERSION,
  IMPLEMENTATION,
  CAPABILITIES,
  createFiscalProviderAdapter,
};
