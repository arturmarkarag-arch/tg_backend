'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.4A contract', () => {
  test('is read-only upstream and reads the current product-offer', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain("method: 'GET'");
    expect(service).toContain('/sale/product-offers/${encodeURIComponent(listing.externalId)}');
    expect(service).not.toContain("method: 'PATCH'");
  });

  test('content preview never mixes price or stock into contentPatch', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain('const contentPatch = {}');
    expect(service).toContain("contentPatch.name = desired.name");
    expect(service).toContain("contentPatch.description = desired.description");
    expect(service).toContain("contentPatch.images = desired.images");
    expect(service).not.toContain('contentPatch.sellingMode');
    expect(service).not.toContain('contentPatch.stock');
  });

  test('price and stock are deferred to dedicated stages', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain("'3D.5'");
    expect(service).toContain("'3D.6'");
    expect(service).toContain('specialized');
  });

  test('category/product/parameter drift requires mapping review', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain("'category.id'");
    expect(service).toContain("'productSet[0].product.id'");
    expect(service).toContain("'productSet[0].product.parameters'");
    expect(service).toContain("nextStage,\n    blocking");
  });

  test('parameter comparison tolerates extra Allegro parameters', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain('parameterSubsetMatches');
    expect(service).toContain('actualById');
  });

  test('image update documents all-or-nothing array semantics', () => {
    const service = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain('Arrays are all-or-nothing');
    expect(service).toContain('повний масив');
  });

  test('route exposes one read-only update preview command', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("'/publications/allegro/update-preview'");
    expect(route).toContain('previewAllegroOfferUpdate');
  });

  test('integration registry distinguishes preview from future content write', () => {
    const registry = read('services/commerce/providers/allegro.js');
    expect(registry).toContain("id: 'offers.update.preview'");
    expect(registry).toContain("id: 'offers.update'");
    expect(registry).toContain('Price/stock');
  });
});
