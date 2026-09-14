'use strict';

const { CAPABILITIES, IMPLEMENTATION, createFiscalProviderAdapter } = require('./contract');
const { validateInvoiceForKsef, prepareOffline24Invoice, submitInvoiceToKsef, getSubmissionStatus, reconcileInvoiceSubmission, getSubmissionUpo } = require('../ksef/submissions');
const { KSEF_SCHEMA } = require('../ksef/config');

module.exports = createFiscalProviderAdapter({
  id: 'ksef',
  name: 'KSeF',
  jurisdiction: 'PL',
  implementation: IMPLEMENTATION.LIVE,
  description: 'Polish KSeF 2.x fiscal provider. Stage 5A adds fail-closed offline24 preparation with imported Offline certificates and QR I/II verification links; inbound sync remains separate.',
  capabilities: {
    [CAPABILITIES.VALIDATE]: true,
    [CAPABILITIES.SUBMIT]: true,
    [CAPABILITIES.STATUS]: true,
    [CAPABILITIES.RECONCILE]: true,
    [CAPABILITIES.RECEIVE]: false,
    [CAPABILITIES.OFFLINE]: true,
    [CAPABILITIES.UPO]: true,
  },
  validate: ({ invoiceId }) => validateInvoiceForKsef(invoiceId),
  submit: ({ invoiceId, environment }) => submitInvoiceToKsef(invoiceId, { environment }),
  getStatus: ({ invoiceId, environment, refresh = true }) => getSubmissionStatus(invoiceId, { environment, refresh }),
  reconcile: ({ invoiceId, environment }) => reconcileInvoiceSubmission(invoiceId, { environment }),
  prepareOffline: ({ invoiceId, environment, mode = 'offline24' }) => {
    if (mode !== 'offline24') throw new TypeError('Stage 5A supports offline24 only');
    return prepareOffline24Invoice(invoiceId, { environment });
  },
  getUpo: ({ invoiceId, environment, refresh = true }) => getSubmissionUpo(invoiceId, { environment, refresh }),
  metadata: {
    apiFamily: 'KSeF API v2',
    schema: KSEF_SCHEMA,
    environments: ['test', 'demo', 'prod'],
    modes: ['online', 'offline24'],
    stage3Limits: { currencies: ['PLN'], invoiceTypes: ['invoice'], vatRates: ['23', '8', '5'] },
    stage4: { reconciliation: 'durable-get-only', upo: 'per-invoice-verified-sha256' },
    stage5: { offline24: 'local-prepare-then-upload', offlineCertificate: 'manual-import-encrypted-at-rest', qr: ['KOD I', 'KOD II'] },
  },
});
