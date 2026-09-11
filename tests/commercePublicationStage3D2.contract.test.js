'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.2 contract', () => {
  test('OAuth and capability matrix expose dedicated sale settings read scope', () => {
    const oauth = read('services/allegroOAuth.js');
    const capabilities = read('services/allegroCapabilities.js');
    expect(oauth).toContain('allegro:api:sale:settings:read');
    expect(capabilities).toContain('SALE_SETTINGS_READ');
    expect(capabilities).toContain('saleSettingsRead');
  });

  test('loads seller sales settings read-only from Allegro', () => {
    const service = read('services/commerce/allegroSalesSettings.js');
    expect(service).toContain("path: '/sale/shipping-rates'");
    expect(service).toContain("path: '/after-sales-service-conditions/return-policies'");
    expect(service).toContain("path: '/after-sales-service-conditions/implied-warranties'");
    expect(service).toContain("path: '/after-sales-service-conditions/warranties'");
    expect(service).toContain("upstreamWriteCalls: 0");
    expect(service).not.toContain("method: 'PATCH'");
    expect(service).not.toContain("method: 'PUT'");
  });

  test('requires reconciled draft before sales settings can be saved', () => {
    const service = read('services/commerce/allegroSalesSettings.js');
    expect(service).toContain('reconciliation.readyForNextStage !== true');
    expect(service).toContain('commerce_allegro_sales_settings_reconciliation_required');
  });

  test('validates shipping, returns, complaints, handling time and location', () => {
    const service = read('services/commerce/allegroSalesSettings.js');
    for (const token of ['shippingRate', 'returnPolicy', 'impliedWarranty', 'handlingTime', 'locationIssues']) {
      expect(service).toContain(token);
    }
    expect(service).toContain("warranty: false");
  });

  test('persists a separate local desired hash without overwriting draft sync hash', () => {
    const service = read('services/commerce/allegroSalesSettings.js');
    expect(service).toContain("state: 'ready_local'");
    expect(service).toContain('settings.desiredHash = salesSettingsHash(settings)');
    expect(service).not.toContain('listing.syncState.desiredHash = settings.desiredHash');
  });

  test('routes and registry expose Stage 3D.2 while activation remains planned', () => {
    const routes = read('routes/commerce.js');
    const registry = read('services/commerce/integrationRegistry.js');
    expect(routes).toContain("'/publications/allegro/sales-settings/resolve'");
    expect(routes).toContain("'/publications/allegro/sales-settings'");
    expect(registry).toMatch(/id: 'offers\.sales-settings\.read'[\s\S]*implementation: LIVE/);
    expect(registry).toMatch(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/);
  });
});
