'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Invoice Core Stage 2 architecture contract', () => {
  it('keeps source providers and fiscal providers as independent axes', () => {
    const creation = read('services/invoices/invoiceCreationService.js');
    const sourceRegistry = read('services/invoices/sourceProviders/registry.js');
    const fiscalRegistry = read('services/invoices/fiscalProviders/registry.js');
    expect(sourceRegistry).toContain('warehouseOrder');
    expect(fiscalRegistry).toContain('getFiscalProviderAdapter');
    expect(creation).not.toContain('fiscalProviders/ksef');
  });

  it('does not let a generic draft PATCH replace issuer identity', () => {
    const service = read('services/invoices/invoiceService.js');
    expect(service).toContain('seller: current.seller');
    expect(service).toContain('invoice_finalized_immutable');
  });

  it('keeps KSeF adapter planned-only until Stage 3', () => {
    const ksef = read('services/invoices/fiscalProviders/ksef.js');
    expect(ksef).toContain('IMPLEMENTATION.PLANNED');
    expect(ksef).not.toContain('axios');
    expect(ksef).not.toContain('/sessions/online');
  });
});
