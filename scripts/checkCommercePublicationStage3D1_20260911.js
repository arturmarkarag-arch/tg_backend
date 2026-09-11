'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (err) { checks.push([name, false, err.message]); } }
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const service = read('services/commerce/allegroDraftReconciliation.js');
const preview = read('services/commerce/publicationPreview.js');
const registry = read('services/commerce/integrationRegistry.js');

check('dedicated draft reconciliation endpoint exists', () => {
  assert(route.includes("router.post('/publications/allegro/drafts/reconcile'"), 'reconcile endpoint missing');
  assert(route.includes('reconcileAllegroDraft'), 'reconcile service missing');
});
check('Stage 3D.1 performs only GET /sale/product-offers/{offerId}', () => {
  assert(service.includes("method: 'GET'"), 'GET missing');
  assert(service.includes('/sale/product-offers/${encodeURIComponent(listing.externalId)}'), 'product-offer read-back missing');
  assert(!service.includes("method: 'PATCH'"), 'PATCH forbidden in Stage 3D.1');
  assert(!service.includes("method: 'PUT'"), 'PUT forbidden in Stage 3D.1');
});
check('managed field drift is checked fail-closed', () => {
  for (const key of ['external_id_mismatch','publication_status_not_inactive','name_drift','category_drift','price_drift','stock_drift','catalog_product_drift','local_payload_changed_since_create']) {
    assert(service.includes(key), `${key} check missing`);
  }
  assert(service.includes('readyForNextStage: blockingCount === 0'), 'readiness gate missing');
});
check('local payload hash is compared with create job hash', () => {
  assert(service.includes('createRequestHash'), 'create hash missing');
  assert(service.includes('currentDesiredHash'), 'current desired hash missing');
  assert(service.includes('createRequestHash !== currentDesiredHash'), 'hash drift comparison missing');
});
check('reconciliation snapshot is persisted and exposed by preview', () => {
  assert(service.includes('reconciliation,'), 'reconciliation persistence missing');
  assert(preview.includes('reconciliation:'), 'preview reconciliation projection missing');
  assert(preview.includes('readyForNextStage'), 'preview readiness missing');
});
check('registry marks reconcile live while activation remains planned', () => {
  assert(registry.match(/id: 'offers\.draft\.reconcile'[\s\S]*implementation: LIVE/), 'reconcile not live');
  assert(registry.match(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/), 'activation must remain planned');
});
check('read scope is required for reconciliation', () => {
  assert(service.includes('saleOffersRead'), 'saleOffersRead gate missing');
  assert(service.includes('commerce_allegro_reconcile_scope_required'), 'scope error missing');
});
check('credentials never enter reconciliation service', () => {
  assert(!service.includes('tokenEncrypted'), 'token leaked');
  assert(!service.includes('clientSecret'), 'client secret leaked');
  assert(!service.includes('refreshToken'), 'refresh token leaked');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3D.1 backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
