'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.2.1 contract', () => {
  test('applies sales settings to product-offer without activation', () => {
    const service = read('services/commerce/allegroSalesSettingsApply.js');
    expect(service).toContain("method: 'PATCH'");
    expect(service).toContain('afterSalesServices:');
    expect(service).toContain('shippingRates:');
    expect(service).toContain('handlingTime');
    expect(service).toContain('location,');
    expect(service).not.toContain("publication: { status: 'ACTIVE'");
  });

  test('requires fresh INACTIVE reconciliation and stable desired hash', () => {
    const service = read('services/commerce/allegroSalesSettingsApply.js');
    expect(service).toContain('reconcileAllegroDraft');
    expect(service).toContain("!== 'INACTIVE'");
    expect(service).toContain('salesSettingsHash(settings)');
    expect(service).toContain('commerce_allegro_sales_settings_apply_hash_mismatch');
  });

  test('never blindly retries ambiguous PATCH', () => {
    const service = read('services/commerce/allegroSalesSettingsApply.js');
    expect(service).toContain("retryPolicy: 'never'");
    expect(service).toContain('maxAttempts: 1');
    expect(service).toContain("onMismatch === 'unknown'");
    expect(service).toContain('Автоматичний повтор заблоковано');
  });

  test('supports Allegro 202 operation polling and read-back verification', () => {
    const service = read('services/commerce/allegroSalesSettingsApply.js');
    expect(service).toContain('providerOperationPath');
    expect(service).toContain('refreshPendingOperation');
    expect(service).toContain('readAndVerifyOffer');
    expect(service).toContain('compareSalesSettings');
    expect(service).toContain('readyForActivation: true');
  });

  test('routes expose command/status and activation stays planned', () => {
    const route = read('routes/commerce.js');
    const registry = read('services/commerce/integrationRegistry.js');
    expect(route).toContain("'/publications/allegro/sales-settings/apply'");
    expect(route).toContain("'/publications/allegro/sales-settings/status'");
    expect(registry).toMatch(/id: 'offers\.sales-settings\.apply'[\s\S]*implementation: LIVE/);
    expect(registry).toMatch(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/);
  });
});
