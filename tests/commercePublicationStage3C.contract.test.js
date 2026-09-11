'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3C contract', () => {
  test('creates only INACTIVE Allegro product-offer drafts', () => {
    const service = read('services/commerce/allegroDraftOffer.js');
    expect(service).toContain("path: '/sale/product-offers'");
    expect(service).toContain("method: 'POST'");
    expect(service).toContain("publication: { status: 'INACTIVE' }");
    expect(service).toContain("retryPolicy: 'never'");
    expect(service).not.toContain("status: 'ACTIVE'");
  });

  test('uses durable external.id recovery before every POST and blocks ambiguous retry', () => {
    const service = read('services/commerce/allegroDraftOffer.js');
    expect(service).toContain("path: '/sale/offers'");
    expect(service).toContain("'external.id': externalKey");
    expect(service).toContain('recoverExisting({ listing, job, hash })');
    expect(service).toContain("job.state === 'unknown'");
    expect(service).toContain('Автоматичний повтор');
  });

  test('persists a generic durable publication job and operation state', () => {
    const model = read('models/CommercePublicationJob.js');
    const service = read('services/commerce/allegroDraftOffer.js');
    expect(model).toContain('idempotencyKey');
    expect(model).toContain("'reserved', 'sending', 'pending', 'confirmed', 'failed', 'unknown'");
    expect(service).toContain('providerOperationPath');
    expect(service).toContain('refreshPendingOperation');
  });

  test('routes expose explicit create and recovery actions', () => {
    const routes = read('routes/commerce.js');
    expect(routes).toContain("'/publications/allegro/drafts'");
    expect(routes).toContain("'/publications/allegro/drafts/status'");
    expect(routes).toContain('createAllegroDraft');
    expect(routes).toContain('refreshAllegroDraft');
  });

  test('integration registry marks draft create live and draft service itself never activates', () => {
    const registry = read('services/commerce/providers/allegro.js');
    expect(registry).toMatch(/id: 'offers\.draft\.create'[\s\S]*implementation: LIVE/);
    const service = read('services/commerce/allegroDraftOffer.js');
    expect(service).toContain("publication: { status: 'INACTIVE' }");
    expect(service).not.toContain("publication: { status: 'ACTIVE' }");
  });
});
