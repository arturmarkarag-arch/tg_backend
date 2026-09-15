'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('commerce order → invoice provider boundary', () => {
  test('registry exposes exact-read Allegro and BaseLinker source adapters', () => {
    const registry = read('services/invoices/sourceProviders/registry.js');
    expect(registry).toContain("require('./allegroOrder')");
    expect(registry).toContain("require('./baseLinkerOrder')");
    expect(registry).toContain('verifyInvoiceSource');
  });

  test('BaseLinker invoice provider exact-reads upstream including discounts instead of using the worker index', () => {
    const source = read('services/invoices/sourceProviders/baseLinkerOrder.js');
    expect(source).toContain("usageStage: 'invoice_source_exact'");
    expect(source).toContain('fetchBaseLinkerOrders({ orderId, includeUnconfirmed: false, includeDiscountsData: true, maxPages: 1 }');
    expect(source).not.toMatch(/BaseLinkerOrderIndex|BaseLinkerPickingState\.find|baseLinkerOrderIndex/i);
    expect(read('services/baseLinkerOrders.js')).toContain('include_discounts_data: true');
  });

  test('Allegro invoice provider exact-reads checkout form instead of using the local order index', () => {
    const source = read('services/invoices/sourceProviders/allegroOrder.js');
    expect(source).toContain('`/order/checkout-forms/${encodeURIComponent(orderId)}`');
    expect(source).toContain("stage: 'invoice_source_exact'");
    expect(source).not.toMatch(/AllegroOrderIndex|AllegroPickingState\.find|allegroOrderIndex/i);
  });

  test('provider order facts are locked and exact-read verified before irreversible finalize', () => {
    const service = read('services/invoices/invoiceService.js');
    expect(service).toContain("authority || '').trim().toLowerCase() === 'upstream_order'");
    expect(service).toContain('items: upstreamLocked ? current.items');
    expect(service).toContain('buyer: correctionLocked || upstreamLocked ? current.buyer');
    expect(service).toContain('await verifyInvoiceSource(sourceCheck)');
    expect(service).toMatch(/await verifyInvoiceSource\(sourceCheck\)[\s\S]*?startSession\(\)/);
  });

  test('provider source creation is idempotent by provider account order and seller', () => {
    const creation = read('services/invoices/invoiceCreationService.js');
    expect(creation).toContain('function sourceIdempotencyKey');
    expect(creation).toContain('`invoice-source:${provider}:${accountId}:${orderId}:${sellerId}`');
    expect(creation).toContain('effectiveIdempotencyKey');
  });

  test('stale provider drafts have an explicit exact-read refresh route', () => {
    const route = read('routes/invoices.js');
    const service = read('services/invoices/invoiceService.js');
    expect(route).toContain("router.post('/:id/source/refresh'");
    expect(service).toContain('async function refreshInvoiceDraftFromSource');
    expect(service).toContain('previewInvoiceDraftFromSource(adapterId');
  });
});
