'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Invoice Core Stage 1 architecture contract', () => {
  it('keeps source providers and fiscal providers independent', () => {
    const source = read('services/invoices/sourceProviders/registry.js');
    const fiscal = read('services/invoices/fiscalProviders/registry.js');
    const service = read('services/invoices/invoiceService.js');
    expect(source).toContain('buildInvoiceDraftFromSource');
    expect(fiscal).toContain('getFiscalProviderAdapter');
    expect(service).not.toContain('fiscalProviders/ksef');
  });

  it('registers KSeF as planned without network implementation', () => {
    const ksef = read('services/invoices/fiscalProviders/ksef.js');
    expect(ksef).toContain('IMPLEMENTATION.PLANNED');
    expect(ksef).toContain("plannedSchema: 'FA(3)'");
    expect(ksef).not.toContain('axios');
    expect(ksef).not.toContain('/sessions/');
  });

  it('does not infer VAT or net/gross semantics from Warehouse Order price', () => {
    const warehouse = read('services/invoices/sourceProviders/warehouseOrder.js');
    expect(warehouse).toContain("priceBasis: override.priceBasis || input.priceBasis || 'unknown'");
    expect(warehouse).toContain('defaultVat');
    expect(warehouse).toContain('invoice_source_quantity_mode_required');
  });

  it('finalizes into a separate hashed snapshot', () => {
    const service = read('services/invoices/invoiceService.js');
    const snapshot = read('models/InvoiceSnapshot.js');
    expect(service).toContain("createHash('sha256')");
    expect(service).toContain('InvoiceSnapshot.create');
    expect(snapshot).toContain('{ invoiceId: 1 }, { unique: true }');
    expect(snapshot).toContain('immutable: true');
  });
});
