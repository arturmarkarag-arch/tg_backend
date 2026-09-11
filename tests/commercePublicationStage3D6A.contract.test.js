'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.6A contract', () => {
  test('keeps the Stage 3D.6A read-only preview route after later stock stages', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("'/publications/allegro/stock-sync/preview'");
  });

  test('preview reads Allegro offers in batches by our stable external ids', () => {
    const service = read('services/commerce/allegroStockSync.js');
    expect(service).toContain("path: '/sale/offers'");
    expect(service).toContain("'external.id': part");
    expect(service).toContain("retryPolicy: 'safe'");
  });

  test('3D.6A performs zero provider writes and requires the reservation ledger before apply', () => {
    const service = read('services/commerce/allegroStockSync.js');
    expect(service).toContain('providerWriteCalls: 0');
    expect(service).not.toContain("method: 'POST'");
  });

  test('models the Allegro zero-stock lifecycle contract explicitly', () => {
    const service = read('services/commerce/allegroStockSync.js');
    expect(service).toContain('zero_stock_will_end_offer');
    expect(service).toContain('offer_reactivation_required');
    expect(service).toContain("publicationStatus === 'ENDED'");
    expect(service).toContain('Повернення stock > 0 не відновить його автоматично');
  });

  test('Commerce Inventory stays the online stock source of truth and fixed channel stock cannot exceed it', () => {
    const preview = read('services/commerce/publicationPreview.js');
    expect(preview).toContain('Commerce Inventory is the online stock source of truth');
    expect(preview).toContain('available: Math.min(inherited, requested)');
    expect(preview).toContain('clamped: requested > inherited');
  });

  test('preview exposes online source, channel policy and actual Allegro stock separately', () => {
    const service = read('services/commerce/allegroStockSync.js');
    expect(service).toContain('source: wholeStock(desiredRaw.source)');
    expect(service).toContain('buffer: wholeStock(desiredRaw.buffer)');
    expect(service).toContain('actualStock');
    expect(service).toContain('desiredStock');
  });

  test('registry keeps stock preview LIVE while stock write stays a separate capability', () => {
    const registry = read('services/commerce/integrationRegistry.js');
    const previewLine = registry.split('\n').find((line) => line.includes("id: 'offers.stock.preview'"));
    const writeLine = registry.split('\n').find((line) => line.includes("id: 'offers.stock.write'") && line.includes('offer-bulk-modification-commands'));
    expect(previewLine).toContain('implementation: LIVE');
    expect(writeLine).toBeTruthy();
  });

  test('Stage 3D.5 price command still does not mix stock writes', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    const fn = service.slice(service.indexOf('function modificationForJob'), service.indexOf('function isAmbiguous'));
    expect(fn).toContain('prices: {');
    expect(fn).not.toContain('stock:');
  });
});
