'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) {
  try { fn(); checks.push([name, true]); }
  catch (err) { checks.push([name, false, err.message]); }
}
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const service = read('services/commerce/allegroDraftOffer.js');
const model = read('models/CommercePublicationJob.js');
const registry = read('services/commerce/integrationRegistry.js');

check('draft create and recovery endpoints exist', () => {
  assert(route.includes("router.post('/publications/allegro/drafts'"), 'draft create endpoint missing');
  assert(route.includes("router.post('/publications/allegro/drafts/status'"), 'draft recovery endpoint missing');
});
check('only INACTIVE product-offer is created', () => {
  assert(service.includes("path: '/sale/product-offers'"), 'POST /sale/product-offers missing');
  assert(service.includes("method: 'POST'"), 'POST method missing');
  assert(service.includes("publication: { status: 'INACTIVE' }"), 'INACTIVE publication missing');
  assert(!service.includes("status: 'ACTIVE'"), 'Stage 3C must not activate offers');
});
check('POST is never blindly retried', () => {
  assert(service.includes("retryPolicy: 'never'"), 'non-idempotent POST retry guard missing');
  assert(service.includes("maxAttempts: 1"), 'single POST attempt guard missing');
  assert(service.includes("job.state === 'unknown'"), 'unknown outcome guard missing');
});
check('stable external.id recovery runs before write', () => {
  assert(service.includes('stableExternalKey'), 'stable external key missing');
  assert(service.includes("path: '/sale/offers'"), 'recovery offer lookup missing');
  assert(service.includes("'external.id': externalKey"), 'external.id filter missing');
  const recoverAt = service.indexOf('const recovered = await recoverExisting({ listing, job, hash });');
  const postAt = service.indexOf("path: '/sale/product-offers'");
  assert(recoverAt >= 0 && postAt >= 0 && recoverAt < postAt, 'recovery must execute before POST');
});
check('durable publication job stores async operation lifecycle', () => {
  assert(model.includes('idempotencyKey'), 'job idempotency key missing');
  assert(model.includes("'reserved', 'sending', 'pending', 'confirmed', 'failed', 'unknown'"), 'job lifecycle missing');
  assert(service.includes('providerOperationPath'), 'operation path persistence missing');
  assert(service.includes('refreshPendingOperation'), 'operation polling missing');
});
check('current Allegro mapping is revalidated immediately before write', () => {
  assert(service.includes('resolveAllegroMapping({'), 'fresh mapping resolve missing');
  assert(service.includes('commerce_allegro_mapping_not_ready'), 'mapping fail-closed guard missing');
});
check('registry exposes draft create only, activation remains planned', () => {
  assert(registry.match(/id: 'offers\.draft\.create'[\s\S]*implementation: LIVE/), 'draft create not live');
  assert(registry.match(/id: 'offers\.publish'[\s\S]*implementation: PLANNED/), 'activation must stay planned');
});
check('credentials never enter commerce publication files', () => {
  assert(!service.includes('tokenEncrypted'), 'token storage leaked');
  assert(!service.includes('clientSecret'), 'client secret leaked');
  assert(!service.includes('refreshToken'), 'refresh token leaked');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3C backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
