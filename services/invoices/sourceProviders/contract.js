'use strict';

const SOURCE_PROVIDER_CONTRACT_VERSION = 1;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function createInvoiceSourceAdapter(definition = {}) {
  const id = text(definition.id, 80).toLowerCase();
  const name = text(definition.name, 160);
  const entityTypes = [...new Set((definition.entityTypes || []).map((value) => text(value, 80).toLowerCase()).filter(Boolean))];
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new TypeError('Invoice source provider id is invalid');
  if (!name) throw new TypeError(`Invoice source provider ${id} requires name`);
  if (!entityTypes.length) throw new TypeError(`Invoice source provider ${id} requires entityTypes`);
  if (typeof definition.buildDraft !== 'function') throw new TypeError(`Invoice source provider ${id} must implement buildDraft()`);

  return Object.freeze({
    contractVersion: SOURCE_PROVIDER_CONTRACT_VERSION,
    id,
    name,
    entityTypes: Object.freeze(entityTypes),
    description: text(definition.description, 1000),
    buildDraft: definition.buildDraft,
    metadata: Object.freeze({ ...(definition.metadata || {}) }),
  });
}

module.exports = { SOURCE_PROVIDER_CONTRACT_VERSION, createInvoiceSourceAdapter };
