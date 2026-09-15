'use strict';

// Compatibility export. Provider metadata, accounts and API coverage now come
// from the single Commerce Provider Registry so integrations cannot drift from
// the adapters that actually execute provider behavior.
const { getCommerceIntegrationRegistry } = require('./providers/registry');

module.exports = { getCommerceIntegrationRegistry };
