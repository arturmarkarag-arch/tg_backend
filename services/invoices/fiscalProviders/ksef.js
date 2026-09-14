'use strict';

const { CAPABILITIES, IMPLEMENTATION, createFiscalProvider } = require('./contract');
const { validateInvoiceForKsef, prepareOffline24Invoice, submitInvoiceToKsef, getSubmissionStatus, reconcileInvoiceSubmission, getSubmissionUpo } = require('../ksef/submissions');
const { KSEF_SCHEMA } = require('../ksef/config');
const { providerBlockers } = require('../ksef/fa3');
const { runInboundSync } = require('../ksef/inboundSync');

module.exports = createFiscalProvider({
  id: 'ksef',
  name: 'KSeF',
  jurisdiction: 'PL',
  implementation: IMPLEMENTATION.LIVE,
  description: 'Polish KSeF 2.x fiscal provider. Outbound online/offline24 plus Stage 6 provider-neutral inbound received-invoice synchronization.',
  capabilities: {
    [CAPABILITIES.VALIDATE]: true,
    [CAPABILITIES.SUBMIT]: true,
    [CAPABILITIES.STATUS]: true,
    [CAPABILITIES.RECONCILE]: true,
    [CAPABILITIES.RECEIVE]: true,
    [CAPABILITIES.OFFLINE]: true,
    [CAPABILITIES.UPO]: true,
  },
  preflightDraft: ({ draft }) => ({
    blockers: providerBlockers({
      ...draft,
      // Invoice numbering is deliberately allocated only at immutable finalize.
      invoiceNumber: draft?.invoiceNumber || '__preview__',
    }).filter((code) => code !== 'invoice_number_required'),
  }),
  validate: ({ invoiceId }) => validateInvoiceForKsef(invoiceId),
  submit: ({ invoiceId, environment }) => submitInvoiceToKsef(invoiceId, { environment }),
  getStatus: ({ invoiceId, environment, refresh = true }) => getSubmissionStatus(invoiceId, { environment, refresh }),
  reconcile: ({ invoiceId, environment }) => reconcileInvoiceSubmission(invoiceId, { environment }),
  prepareOffline: ({ invoiceId, environment, mode = 'offline24' }) => {
    if (mode !== 'offline24') throw new TypeError('Stage 5A supports offline24 only');
    return prepareOffline24Invoice(invoiceId, { environment });
  },
  getUpo: ({ invoiceId, environment, refresh = true }) => getSubmissionUpo(invoiceId, { environment, refresh }),
  receive: ({ syncId }) => runInboundSync(syncId),
  metadata: {
    apiFamily: 'KSeF API v2',
    schema: KSEF_SCHEMA,
    environments: ['test', 'demo', 'prod'],
    modes: ['online', 'offline24'],
    stage3Limits: { currencies: ['PLN'], invoiceTypes: ['invoice'], vatRates: ['23', '8', '5'] },
    stage4: { reconciliation: 'durable-get-only', upo: 'per-invoice-verified-sha256' },
    stage5: { offline24: 'local-prepare-then-upload', offlineCertificate: 'manual-import-encrypted-at-rest', qr: ['KOD I', 'KOD II'] },
    stage6: { inbound: 'Subject2 PermanentStorage HWM', localArtifact: 'sha256-verified immutable XML', hydration: 'rate-safe scheduler', highVolume: 'TarGz export with encrypted/plain part integrity' },
  },
});
