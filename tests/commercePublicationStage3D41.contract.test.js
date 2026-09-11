'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.4.1 contract', () => {
  test('applies one minimal content PATCH to product-offer', () => {
    const service = read('services/commerce/allegroOfferContentUpdate.js');
    expect(service).toContain("method: 'PATCH'");
    expect(service).toContain('/sale/product-offers/${encodeURIComponent(listing.externalId)}');
    expect(service).toContain('body: patch');
    expect(service).toContain("retryPolicy: 'never'");
  });

  test('fresh preview owns the safe patch boundary', () => {
    const service = read('services/commerce/allegroOfferContentUpdate.js');
    expect(service).toContain('previewAllegroOfferUpdate');
    expect(service).toContain('mappingChangeCount');
    expect(service).toContain('preview.contentPatch');
  });

  test('price stock category and product id are absent from contentPatch builder', () => {
    const preview = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(preview).toContain('contentPatch.name = desired.name');
    expect(preview).toContain('contentPatch.description = desired.description');
    expect(preview).toContain('contentPatch.images = desired.images');
    expect(preview).not.toContain('contentPatch.sellingMode');
    expect(preview).not.toContain('contentPatch.stock');
    expect(preview).not.toContain('contentPatch.category');
    expect(preview).not.toContain('contentPatch.productSet');
  });

  test('async and ambiguous outcomes are durable and never blindly retried', () => {
    const service = read('services/commerce/allegroOfferContentUpdate.js');
    expect(service).toContain("state: { $in: ['sending', 'pending', 'unknown'] }");
    expect(service).toContain('providerOperationPath');
    expect(service).toContain('recoverUnknown');
    expect(service).toContain('retryUnknown');
  });

  test('read-back verifies only the stored patch from the durable job', () => {
    const service = read('services/commerce/allegroOfferContentUpdate.js');
    const preview = read('services/commerce/allegroOfferUpdatePreview.js');
    expect(service).toContain('storedPatch(job)');
    expect(service).toContain('contentPatchIssues(patch, offer)');
    expect(preview).toContain('function contentPatchIssues');
  });

  test('route exposes one update-content business command', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("'/publications/allegro/update-content'");
    expect(route).toContain('applyAllegroOfferContent');
    expect(route).not.toContain("'/publications/allegro/update-content/status'");
  });

  test('publication preview exposes durable content update state', () => {
    const preview = read('services/commerce/publicationPreview.js');
    expect(preview).toContain('contentUpdate:');
    expect(preview).toContain('canRetry: listing.providerData.allegro.contentUpdate.canRetry === true');
  });

  test('integration registry marks content update live while price stock remain planned', () => {
    const registry = read('services/commerce/integrationRegistry.js');
    expect(registry).toContain("id: 'offers.update'");
    expect(registry).toContain('safe contentPatch');
    expect(registry).toContain("id: 'offers.price.write'");
    expect(registry).toContain("id: 'offers.stock.write'");
  });
});
