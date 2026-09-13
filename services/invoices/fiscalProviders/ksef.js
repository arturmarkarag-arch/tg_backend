'use strict';

const { CAPABILITIES, IMPLEMENTATION, createFiscalProviderAdapter } = require('./contract');

module.exports = createFiscalProviderAdapter({
  id: 'ksef',
  name: 'KSeF',
  jurisdiction: 'PL',
  implementation: IMPLEMENTATION.PLANNED,
  description: 'Polish Krajowy System e-Faktur fiscal provider. Stage 1 reserves the provider boundary only; no network/auth/FA(3) implementation lives here yet.',
  capabilities: {
    [CAPABILITIES.VALIDATE]: false,
    [CAPABILITIES.SUBMIT]: false,
    [CAPABILITIES.STATUS]: false,
    [CAPABILITIES.RECONCILE]: false,
    [CAPABILITIES.RECEIVE]: false,
    [CAPABILITIES.OFFLINE]: false,
    [CAPABILITIES.UPO]: false,
  },
  metadata: {
    plannedSchema: 'FA(3)',
  },
});
