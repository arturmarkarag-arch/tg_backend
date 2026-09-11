'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.1 contract', () => {
  test('reconciliation reads the created product-offer and never activates or patches it', () => {
    const service = read('services/commerce/allegroDraftReconciliation.js');
    expect(service).toContain("method: 'GET'");
    expect(service).toContain('`/sale/product-offers/${encodeURIComponent(listing.externalId)}`');
    expect(service).not.toContain("method: 'PATCH'");
    expect(service).not.toContain("status: 'ACTIVE'");
  });

  test('compares managed fields and local payload hash before next stage', () => {
    const service = read('services/commerce/allegroDraftReconciliation.js');
    expect(service).toContain('external_id_mismatch');
    expect(service).toContain('publication_status_not_inactive');
    expect(service).toContain('price_drift');
    expect(service).toContain('stock_drift');
    expect(service).toContain('category_drift');
    expect(service).toContain('catalog_product_drift');
    expect(service).toContain('local_payload_changed_since_create');
    expect(service).toContain('readyForNextStage: blockingCount === 0');
  });

  test('persists only our reconciliation snapshot and sync state', () => {
    const service = read('services/commerce/allegroDraftReconciliation.js');
    expect(service).toContain('providerData.allegro =');
    expect(service).toContain('reconciliation,');
    expect(service).toContain("state: reconciliation.readyForNextStage ? 'in_sync' : 'out_of_sync'");
  });

  test('route and registry expose Stage 3D.1 as read coverage', () => {
    const routes = read('routes/commerce.js');
    const registry = read('services/commerce/integrationRegistry.js');
    expect(routes).toContain("'/publications/allegro/drafts/reconcile'");
    expect(routes).toContain('reconcileAllegroDraft');
    expect(registry).toMatch(/id: 'offers\.draft\.reconcile'[\s\S]*direction: 'read'[\s\S]*implementation: LIVE/);
    expect(registry).toMatch(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/);
  });
});
