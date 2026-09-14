'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Invoice Core Stage 2 architecture contract', () => {
  it('keeps source adapters and fiscal providers as independent axes', () => {
    const creation = read('services/invoices/invoiceCreationService.js');
    const sourceRegistry = read('services/invoices/sourceProviders/registry.js');
    const fiscalRegistry = read('services/invoices/fiscalProviders/registry.js');
    expect(sourceRegistry).toContain('warehouseOrder');
    expect(fiscalRegistry).toContain('getFiscalProvider');
    expect(creation).not.toContain('fiscalProviders/ksef');
  });

  it('does not let a generic draft PATCH replace issuer identity', () => {
    const service = read('services/invoices/invoiceService.js');
    expect(service).toContain('seller: current.seller');
    expect(service).toContain('invoice_finalized_immutable');
  });

  it('keeps KSeF implementation outside the Stage 2 creation layer', () => {
    const ksef = read('services/invoices/fiscalProviders/ksef.js');
    const creation = read('services/invoices/invoiceCreationService.js');
    expect(ksef).toContain('createFiscalProvider');
    expect(ksef).toContain("id: 'ksef'");
    expect(creation).not.toContain('fiscalProviders/ksef');
    expect(creation).not.toContain('services/invoices/ksef');
  });
});
