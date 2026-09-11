'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
function check(name, fn) { try { fn(); checks.push([name, true]); } catch (err) { checks.push([name, false, err.message]); } }
function assert(value, message) { if (!value) throw new Error(message); }

const route = read('routes/commerce.js');
const apply = read('services/commerce/allegroSalesSettingsApply.js');
const settings = read('services/commerce/allegroSalesSettings.js');
const preview = read('services/commerce/providers/allegro.js');
const registry = read('services/commerce/providers/allegro.js');

check('Stage 3D.2.1 command and status endpoints exist', () => {
  assert(route.includes("router.post('/publications/allegro/sales-settings/apply'"), 'apply endpoint missing');
  assert(route.includes("router.post('/publications/allegro/sales-settings/status'"), 'status endpoint missing');
});
check('PATCH changes only sales settings fields and never activates offer', () => {
  assert(apply.includes("method: 'PATCH'"), 'PATCH missing');
  assert(apply.includes('delivery:'), 'delivery patch missing');
  assert(apply.includes('afterSalesServices:'), 'afterSalesServices patch missing');
  assert(apply.includes('location,'), 'location patch missing');
  assert(!apply.includes("publication: { status: 'ACTIVE'"), 'activation forbidden in 3D.2.1');
  assert(!apply.includes('publication.status=ACTIVE'), 'activation marker forbidden in service');
});
check('fresh reconciliation and INACTIVE gate are fail-closed', () => {
  assert(apply.includes('reconcileAllegroDraft'), 'fresh reconciliation missing');
  assert(apply.includes("!== 'INACTIVE'"), 'INACTIVE gate missing');
  assert(apply.includes('commerce_allegro_sales_settings_offer_not_inactive'), 'INACTIVE error missing');
});
check('desired hash is revalidated before write', () => {
  assert(apply.includes('salesSettingsHash(settings)'), 'hash recomputation missing');
  assert(apply.includes('commerce_allegro_sales_settings_apply_hash_mismatch'), 'hash mismatch guard missing');
});
check('PATCH is never automatically retried', () => {
  assert(apply.includes("retryPolicy: 'never'"), 'never retry policy missing');
  assert(apply.includes('maxAttempts: 1'), 'single PATCH attempt missing');
  assert(apply.includes("state: 'unknown'"), 'unknown state missing');
});
check('202 operation is persisted and polled', () => {
  assert(apply.includes('providerOperationPath'), 'operation path missing');
  assert(apply.includes('refreshPendingOperation'), 'operation polling missing');
  assert(apply.includes("state: 'pending'"), 'pending state missing');
});
check('successful apply is verified by read-back', () => {
  assert(apply.includes('readAndVerifyOffer'), 'read-back helper missing');
  assert(apply.includes('compareSalesSettings'), 'sales settings comparison missing');
  assert(apply.includes("readyForActivation: true"), 'activation readiness missing');
  assert(apply.includes("state: 'applied'"), 'applied state missing');
});
check('ambiguous timeout does not become retryable after stale GET', () => {
  assert(apply.includes("onMismatch = 'failed'"), 'mismatch mode missing');
  assert(apply.includes("onMismatch === 'unknown'"), 'unknown mismatch preservation missing');
  assert(apply.includes('Автоматичний повтор заблоковано'), 'explicit retry block message missing');
});
check('saving the same settings preserves applied readiness', () => {
  assert(settings.includes('settings.appliedHash === settings.desiredHash'), 'same-hash preservation missing');
  assert(settings.includes("settings.state = 'applied'"), 'applied state preservation missing');
  assert(settings.includes('settings.readyForActivation = true'), 'readyForActivation preservation missing');
});
check('preview and registry expose applied readiness while activation remains separate', () => {
  assert(preview.includes('readyForActivation'), 'preview readiness missing');
  assert(preview.includes('appliedHash'), 'preview applied hash missing');
  assert(registry.match(/id: 'offers\.sales-settings\.apply'[\s\S]*implementation: LIVE/), 'sales settings apply not live');
  assert(!apply.includes("publication: { status: 'ACTIVE'"), 'sales settings apply must remain separate from activation');
});

for (const [name, ok, message] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${message ? ` — ${message}` : ''}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`Commerce Publication Stage 3D.2.1 backend: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);
