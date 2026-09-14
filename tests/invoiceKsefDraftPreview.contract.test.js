'use strict';

const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('KSeF draft preflight contract', () => {
  it('keeps preview provider-neutral and runs KSeF blockers before numbering/finalize', () => {
    const route = read('routes/invoices.js');
    const provider = read('services/invoices/fiscalProviders/ksef.js');
    const contract = read('services/invoices/fiscalProviders/contract.js');

    expect(route).toContain('getFiscalProviderAdapter');
    expect(route).toContain("typeof fiscalProvider.preflightDraft === 'function'");
    expect(route).not.toContain("services/invoices/ksef/fa3");
    expect(contract).toContain('preflightDraft: definition.preflightDraft || null');
    expect(provider).toContain('preflightDraft: ({ draft })');
    expect(provider).toContain("invoiceNumber: draft?.invoiceNumber || '__preview__'");
    expect(provider).toContain("filter((code) => code !== 'invoice_number_required')");
  });
});
