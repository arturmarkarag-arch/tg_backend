'use strict';

const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('Commerce publication Stage 3A contract', () => {
  test('Allegro OAuth and capability matrix include offer write scope', () => {
    const oauth = read('services/allegroOAuth.js');
    const caps = read('services/allegroCapabilities.js');
    expect(oauth).toContain("'allegro:api:sale:offers:write'");
    expect(caps).toContain("SALE_OFFERS_WRITE: 'allegro:api:sale:offers:write'");
    expect(caps).toContain('saleOffersWrite');
  });

  test('preview is local-only and route does not publish upstream', () => {
    const route = read('routes/commerce.js');
    const preview = read('services/commerce/publicationPreview.js');
    expect(route).toContain("router.post('/publications/preview'");
    expect(preview).toContain('providerCalls: 0');
    expect(preview).not.toContain("'/sale/product-offers'");
    expect(preview).not.toContain('allegroRequest(');
  });

  test('ChannelListing has unique product/provider/account identity', () => {
    const model = read('models/ChannelListing.js');
    expect(model).toContain('identityKey');
    expect(model).toContain('{ identityKey: 1 }');
    expect(model).toContain('{ unique: true, partialFilterExpression');
  });

  test('preflight validates account write permission and product essentials', () => {
    const preview = read('services/commerce/providers/allegro.js');
    expect(preview).toContain('missing_sale_offers_write_scope');
    expect(preview).toContain('title_invalid');
    expect(preview).toContain('price_required');
    expect(preview).toContain('stock_required');
    expect(preview).toContain('category_mapping_required');
  });

  test('integration registry advertises preflight but keeps real publish planned', () => {
    const registry = read('services/commerce/providers/allegro.js');
    expect(registry).toContain("id: 'offers.preflight'");
    expect(registry).toContain("capability: 'saleOffersWrite'");
    expect(registry).toContain("id: 'offers.publish'");
  });
});
