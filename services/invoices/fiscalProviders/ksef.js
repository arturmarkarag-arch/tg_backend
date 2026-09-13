'use strict';

const { CAPABILITIES, IMPLEMENTATION, createFiscalProviderAdapter } = require('./contract');
const { validateInvoiceForKsef, submitInvoiceToKsef, getSubmissionStatus } = require('../ksef/submissions');
const { KSEF_SCHEMA } = require('../ksef/config');

module.exports = createFiscalProviderAdapter({
  id: 'ksef',
  name: 'KSeF',
  jurisdiction: 'PL',
  implementation: IMPLEMENTATION.LIVE,
  description: 'Polish KSeF 2.x fiscal provider. Stage 3 supports online FA(3) submission for the conservative PLN/standard-VAT subset; durable retries, UPO, offline modes and inbound sync are separate stages.',
  capabilities: {
    [CAPABILITIES.VALIDATE]: true,
    [CAPABILITIES.SUBMIT]: true,
    [CAPABILITIES.STATUS]: true,
    [CAPABILITIES.RECONCILE]: true,
    [CAPABILITIES.RECEIVE]: false,
    [CAPABILITIES.OFFLINE]: false,
    [CAPABILITIES.UPO]: false,
  },
  validate: ({ invoiceId }) => validateInvoiceForKsef(invoiceId),
  submit: ({ invoiceId, environment }) => submitInvoiceToKsef(invoiceId, { environment }),
  getStatus: ({ invoiceId, environment, refresh = true }) => getSubmissionStatus(invoiceId, { environment, refresh }),
  reconcile: ({ invoiceId, environment }) => getSubmissionStatus(invoiceId, { environment, refresh: true }),
  metadata: {
    apiFamily: 'KSeF API v2',
    schema: KSEF_SCHEMA,
    environments: ['test', 'demo', 'prod'],
    modes: ['online'],
    stage3Limits: { currencies: ['PLN'], invoiceTypes: ['invoice'], vatRates: ['23', '8', '5'] },
  },
});
