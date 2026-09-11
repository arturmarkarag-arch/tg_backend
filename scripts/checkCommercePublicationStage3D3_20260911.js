'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (err) { checks.push([name, false, err.message]); } }
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const activation = read('services/commerce/allegroActivation.js');
const preview = read('services/commerce/providers/allegro.js');
const registry = read('services/commerce/providers/allegro.js');

check('one internal activation command exists without a duplicate status endpoint', () => {
  assert(route.includes("router.post('/publications/allegro/activate'"), 'activation endpoint missing');
  assert(!route.includes("/publications/allegro/activate/status"), 'unnecessary activation status endpoint found');
});
check('upstream activation is the minimal documented PATCH only', () => {
  assert(activation.includes("method: 'PATCH'"), 'PATCH missing');
  assert(activation.includes("body: { publication: { status: 'ACTIVE' } }"), 'minimal ACTIVE body missing');
  assert(!activation.includes('sellingMode: {'), 'activation must not edit price');
  assert(!activation.includes('stock: { available:'), 'activation must not edit stock');
});
check('final gate revalidates preflight, reconciliation and applied Sales Settings', () => {
  assert(activation.includes('previewPublication'), 'fresh preflight missing');
  assert(activation.includes('reconcileAllegroDraft'), 'fresh reconciliation missing');
  assert(activation.includes('readyForActivation !== true'), 'sales readiness gate missing');
  assert(activation.includes("settings?.apply?.state, 40) !== 'confirmed'"), 'confirmed apply gate missing');
  assert(activation.includes('compareSalesSettings'), 'final sales settings read-back comparison missing');
});
check('activation does not blindly retry ambiguous PATCH', () => {
  assert(activation.includes("retryPolicy: 'never'"), 'never retry policy missing');
  assert(activation.includes('retryUnknown'), 'explicit unknown retry flag missing');
  assert(activation.includes('canRetry: true'), 'explicit retry readiness missing');
  assert(activation.includes('Автоматично не повторюємо'), 'fail-closed recovery message missing');
});
check('202 operation and read-back recovery are durable', () => {
  assert(activation.includes('providerOperationPath'), 'operation path missing');
  assert(activation.includes('refreshPendingOperation'), 'operation polling missing');
  assert(activation.includes("status === 'ACTIVE'"), 'ACTIVE confirmation missing');
  assert(activation.includes("status === 'ACTIVATING'"), 'ACTIVATING handling missing');
});
check('preview exposes durable activation state', () => {
  assert(preview.includes('activation:'), 'activation preview projection missing');
  assert(preview.includes('publicationStatus'), 'publication status projection missing');
  assert(preview.includes('canRetry'), 'retry state projection missing');
});
check('registry marks activation live using product-offer PATCH', () => {
  assert(registry.match(/id: 'offers\.publish'[\s\S]*publication\.status=ACTIVE[\s\S]*implementation: LIVE/), 'activation not marked live');
  assert(registry.includes('окремого Allegro publish endpoint не використовуємо'), 'endpoint rationale missing');
});
check('activation remains a separate business commit from sales-settings apply', () => {
  const apply = read('services/commerce/allegroSalesSettingsApply.js');
  assert(!apply.includes("publication: { status: 'ACTIVE'"), 'sales settings apply activates offer');
  assert(activation.includes("const ACTION = 'activate_offer'"), 'separate durable action missing');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3D.3 backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
