'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce Provider Core v1 contract', () => {
  test('core has a versioned adapter contract and capability matrix', () => {
    const contract = read('services/commerce/providers/contract.js');
    expect(contract).toContain('PROVIDER_CONTRACT_VERSION = 1');
    expect(contract).toContain("LISTING_PREVIEW: 'listing.preview'");
    expect(contract).toContain("LISTING_CREATE: 'listing.create'");
    expect(contract).toContain("PRICE_SYNC: 'listing.price.sync'");
    expect(contract).toContain("STOCK_SYNC: 'listing.stock.sync'");
  });

  test('publication preview dispatches to provider adapter without provider branches', () => {
    const preview = read('services/commerce/publicationPreview.js');
    expect(preview).toContain('getProviderAdapter');
    expect(preview).toContain('adapter.preparePublicationPreview');
    expect(preview).toContain('adapter.previewPublicationRow');
    expect(preview).not.toContain("provider === 'allegro'");
    expect(preview).not.toContain("provider === 'olx'");
    expect(preview).not.toContain("provider === 'temu'");
    expect(preview).toContain('providerCalls: 0');
  });

  test('Allegro is an adapter and provider-specific state stays namespaced', () => {
    const adapter = read('services/commerce/providers/allegro.js');
    expect(adapter).toContain("id: 'allegro'");
    expect(adapter).toContain('createProviderAdapter');
    expect(adapter).toContain('listing?.providerData?.allegro');
    expect(adapter).toContain("'draft.create'");
    expect(adapter).toContain("'price.apply'");
    expect(adapter).toContain("'stock.apply'");
    expect(adapter).toContain("'lifecycle.apply'");
    expect(adapter).toContain("'health.scan'");
  });

  test('OLX and Temu are registered planned adapters without contaminating core product', () => {
    const registry = read('services/commerce/providers/registry.js');
    const planned = read('services/commerce/providers/planned.js');
    const product = read('models/CommerceProduct.js');
    expect(registry).toContain('[olx.id, olx]');
    expect(registry).toContain('[temu.id, temu]');
    expect(planned).toContain("id: 'olx'");
    expect(planned).toContain("id: 'temu'");
    expect(product).not.toMatch(/allegro|olx|temu/i);
  });

  test('one generic provider operation route exists while legacy aliases can coexist', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("router.get('/providers'");
    expect(route).toContain("router.post('/providers/:provider/operations/:operation'");
    expect(route).toContain('executeProviderOperation');
  });

  test('provider-neutral durable models remain generic', () => {
    const listing = read('models/ChannelListing.js');
    const job = read('models/CommercePublicationJob.js');
    expect(listing).toContain('provider: { type: String');
    expect(listing).toContain('providerData');
    expect(job).toContain('provider: { type: String');
    expect(job).toContain('action: { type: String');
    expect(job).not.toMatch(/allegro|olx|temu/i);
  });

  test('architecture document freezes the isolation rules', () => {
    const doc = read('services/commerce/providers/README.md');
    expect(doc).toContain('Do not add provider fields to `CommerceProduct`');
    expect(doc).toContain('Product.quantity');
    expect(doc).toContain('providerData[provider]');
  });
});
