'use strict';

const PROVIDER_CONTRACT_VERSION = 1;

const IMPLEMENTATION = Object.freeze({
  LIVE: 'live',
  PLANNED: 'planned',
});

const PROVIDER_TYPES = Object.freeze({
  MARKETPLACE: 'marketplace',
  SHOP: 'shop',
  AGGREGATOR: 'aggregator',
});

const CAPABILITIES = Object.freeze({
  ACCOUNTS: 'accounts',
  ORDERS_READ: 'orders.read',
  PRODUCT_MAPPING: 'product.mapping',
  LISTING_PREVIEW: 'listing.preview',
  LISTING_CREATE: 'listing.create',
  LISTING_UPDATE_CONTENT: 'listing.update.content',
  PRICE_SYNC: 'listing.price.sync',
  STOCK_SYNC: 'listing.stock.sync',
  LIFECYCLE: 'listing.lifecycle',
  HEALTH: 'listing.health',
});

const OPERATION_KINDS = Object.freeze({
  READ: 'read',
  LOCAL_WRITE: 'local_write',
  PROVIDER_WRITE: 'provider_write',
});

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeCapabilities(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) out[text(key, 120)] = value === true;
  return Object.freeze(out);
}

function normalizeOperation(id, raw = {}) {
  const operationId = text(id, 120);
  if (!operationId) throw new TypeError('Commerce provider operation id is required');
  const kind = text(raw.kind, 40) || OPERATION_KINDS.READ;
  if (!Object.values(OPERATION_KINDS).includes(kind)) throw new TypeError(`Invalid provider operation kind: ${kind}`);
  if (typeof raw.execute !== 'function') throw new TypeError(`Provider operation ${operationId} must implement execute()`);
  return Object.freeze({
    id: operationId,
    kind,
    capability: text(raw.capability, 120),
    description: text(raw.description, 500),
    execute: raw.execute,
    httpStatus: typeof raw.httpStatus === 'function' ? raw.httpStatus : (() => 200),
  });
}

function createProviderAdapter(definition = {}) {
  const id = text(definition.id, 60).toLowerCase();
  const name = text(definition.name, 120);
  const type = text(definition.type, 40);
  const implementation = text(definition.implementation, 40);
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new TypeError('Commerce provider id is invalid');
  if (!name) throw new TypeError(`Commerce provider ${id} requires name`);
  if (!Object.values(PROVIDER_TYPES).includes(type)) throw new TypeError(`Commerce provider ${id} has invalid type`);
  if (!Object.values(IMPLEMENTATION).includes(implementation)) throw new TypeError(`Commerce provider ${id} has invalid implementation`);

  const capabilities = normalizeCapabilities(definition.capabilities);
  const operations = {};
  for (const [operationId, operation] of Object.entries(definition.operations || {})) {
    operations[operationId] = normalizeOperation(operationId, operation);
  }

  if (implementation === IMPLEMENTATION.LIVE) {
    if (typeof definition.listAccounts !== 'function') throw new TypeError(`Live provider ${id} must implement listAccounts()`);
    if (capabilities[CAPABILITIES.LISTING_PREVIEW] === true && typeof definition.preparePublicationPreview !== 'function') {
      throw new TypeError(`Provider ${id} with listing.preview must implement preparePublicationPreview()`);
    }
    if (capabilities[CAPABILITIES.LISTING_PREVIEW] === true && typeof definition.previewPublicationRow !== 'function') {
      throw new TypeError(`Provider ${id} with listing.preview must implement previewPublicationRow()`);
    }
  }

  return Object.freeze({
    contractVersion: PROVIDER_CONTRACT_VERSION,
    id,
    name,
    type,
    implementation,
    description: text(definition.description, 1000),
    capabilities,
    operations: Object.freeze(operations),
    listAccounts: definition.listAccounts || (async () => []),
    publicAccount: typeof definition.publicAccount === 'function' ? definition.publicAccount : ((account) => account),
    preparePublicationPreview: definition.preparePublicationPreview || (async () => ({})),
    previewPublicationRow: definition.previewPublicationRow || null,
    integrationApi: Array.isArray(definition.integrationApi) ? Object.freeze(definition.integrationApi.map((item) => Object.freeze({ ...item }))) : Object.freeze([]),
    metadata: Object.freeze({ ...(definition.metadata || {}) }),
  });
}

module.exports = {
  PROVIDER_CONTRACT_VERSION,
  IMPLEMENTATION,
  PROVIDER_TYPES,
  CAPABILITIES,
  OPERATION_KINDS,
  createProviderAdapter,
};
