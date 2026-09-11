'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3B contract', () => {
  test('mapping resolves Allegro catalog/categories through read-only endpoints', () => {
    const service = read('services/commerce/allegroMapping.js');
    expect(service).toContain("path: '/sale/products'");
    expect(service).toContain("mode: 'GTIN'");
    expect(service).toContain("path: '/sale/matching-categories'");
    expect(service).toContain('/parameters`');
    expect(service).toContain('providerWriteCalls: 0');
    expect(service).not.toContain("method: 'POST'");
    expect(service).not.toContain("'/sale/product-offers'");
  });

  test('mapping is persisted locally and consumed by preflight', () => {
    const service = read('services/commerce/allegroMapping.js');
    const preview = read('services/commerce/publicationPreview.js');
    expect(service).toContain('productParameters');
    expect(service).toContain('offerParameters');
    expect(service).toContain('mappingState');
    expect(preview).toContain("allegroMapping.mappingState === 'ready'");
  });

  test('real Allegro offer creation is still planned', () => {
    const registry = read('services/commerce/integrationRegistry.js');
    expect(registry).toMatch(/id: 'catalog\.mapping'[\s\S]*implementation: LIVE/);
    expect(registry).toMatch(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/);
  });
});
