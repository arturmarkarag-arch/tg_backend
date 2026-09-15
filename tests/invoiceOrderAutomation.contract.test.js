'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('provider-neutral order -> invoice draft automation', () => {
  it('keeps marketplace detection inside provider adapters', () => {
    const core = read('services/invoices/providerOrderAutomation.js');
    expect(core).toContain('getProviderAdapter(providerId');
    expect(core).not.toMatch(/providerId\s*===\s*['"](?:allegro|baselinker|olx|temu)/);
    expect(read('services/commerce/providers/allegro.js')).toContain("adapterId: 'allegro_order'");
    expect(read('services/commerce/providers/baseLinker.js')).toContain("adapterId: 'baselinker_order'");
  });

  it('never auto-finalizes or auto-submits fiscal documents', () => {
    const core = read('services/invoices/providerOrderAutomation.js');
    expect(core).toContain('createInvoiceFromSource');
    expect(core).not.toContain('finalizeInvoice');
    expect(core).not.toContain('submitInvoiceToKsef');
  });

  it('refreshes changed upstream data into an existing draft and throttles blocked retries', () => {
    const core = read('services/invoices/providerOrderAutomation.js');
    expect(core).toContain('refreshInvoiceDraftFromSource');
    expect(core).toContain('previous?.invoiceId');
    expect(core).toContain('nextRetryAt');
    expect(core).toContain('BLOCKED_RETRY_MS');
  });

  it('records finalized-source drift as a terminal audit state', () => {
    const core = read('services/invoices/providerOrderAutomation.js');
    expect(core).toContain('finalized_source_changed');
    expect(core).toContain('invoice_finalized_source_changed');
  });

  it('persists only operational automation state, not upstream PII', () => {
    const model = read('models/InvoiceSourceAutomationState.js');
    expect(model).toContain('revision');
    expect(model).toContain('blockers');
    expect(model).not.toContain('buyer');
    expect(model).not.toContain('address');
    expect(model).not.toContain('taxId');
  });
});
