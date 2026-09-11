'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (err) { checks.push([name, false, err.message]); } }
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const service = read('services/commerce/allegroSalesSettings.js');
const preview = read('services/commerce/providers/allegro.js');
const registry = read('services/commerce/providers/allegro.js');
const oauth = read('services/allegroOAuth.js');
const capabilities = read('services/allegroCapabilities.js');

check('OAuth requests dedicated sale settings read scope', () => {
  assert(oauth.includes('allegro:api:sale:settings:read'), 'sale settings read scope missing from OAuth defaults');
  assert(capabilities.includes('SALE_SETTINGS_READ'), 'sale settings capability constant missing');
  assert(capabilities.includes('saleSettingsRead'), 'saleSettingsRead capability missing');
});
check('Stage 3D.2 endpoints exist', () => {
  assert(route.includes("router.post('/publications/allegro/sales-settings/resolve'"), 'resolve endpoint missing');
  assert(route.includes("router.put('/publications/allegro/sales-settings'"), 'save endpoint missing');
});
check('four seller-owned Allegro settings resources are read', () => {
  for (const resource of ['/sale/shipping-rates','/after-sales-service-conditions/return-policies','/after-sales-service-conditions/implied-warranties','/after-sales-service-conditions/warranties']) {
    assert(service.includes(resource), `${resource} missing`);
  }
});
check('Stage 3D.2 has zero upstream writes', () => {
  assert(service.includes('upstreamWriteCalls: 0'), 'zero-write marker missing');
  assert(!service.includes("method: 'PATCH'"), 'PATCH forbidden');
  assert(!service.includes("method: 'PUT'"), 'PUT forbidden');
  assert(!service.includes("method: 'POST'"), 'POST to Allegro forbidden');
});
check('reconciled draft is mandatory', () => {
  assert(service.includes('reconciliation.readyForNextStage !== true'), 'reconciliation gate missing');
  assert(service.includes('commerce_allegro_sales_settings_reconciliation_required'), 'reconciliation error missing');
});
check('required sales settings are fail-closed', () => {
  for (const token of ['shippingRate','returnPolicy','impliedWarranty','validHandlingTime','locationIssues']) assert(service.includes(token), `${token} missing`);
  assert(service.includes('commerce_allegro_sales_settings_invalid'), 'validation error missing');
});
check('saved mapping has independent desired hash', () => {
  assert(service.includes("state: 'ready_local'"), 'ready_local state missing');
  assert(service.includes('settings.desiredHash = salesSettingsHash(settings)'), 'settings desired hash missing');
  assert(!service.includes('listing.syncState.desiredHash = settings.desiredHash'), 'draft desired hash must not be overwritten');
});
check('preview exposes saved sales settings', () => {
  assert(preview.includes('salesSettings:'), 'preview sales settings projection missing');
  assert(preview.includes('readyForApply'), 'readyForApply missing');
});
check('registry marks sales settings live while Stage 3D.2 remains upstream read-only', () => {
  assert(registry.match(/id: 'offers\.sales-settings\.read'[\s\S]*implementation: LIVE/), 'sales settings not live');
  assert(!service.includes("method: 'PATCH'"), 'Stage 3D.2 must not activate/edit offer');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3D.2 backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
