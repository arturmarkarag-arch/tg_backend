'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
const checks = [];
function check(name, fn) {
  checks.push(name);
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name} — ${error.message}`); }
}

const stock = read('services/commerce/stockReservations.js');
const route = read('routes/commerce.js');
const integration = read('services/commerce/integrationRegistry.js');
const registry = read('services/commerce/providers/registry.js');
const allegro = read('services/commerce/providers/allegro.js');
const baseLinker = read('services/commerce/providers/baseLinker.js');
const preview = read('services/commerce/publicationPreview.js');
const product = read('models/CommerceProduct.js');
const listing = read('models/ChannelListing.js');

check('reservation core has no provider model imports or provider-name branching', () => {
  assert(!/AllegroOrderIndex|BaseLinkerOrderIndex|BaseLinkerPickingOrder/.test(stock));
  assert(!/['"](?:allegro|baselinker|olx|temu)['"]/i.test(stock));
  assert(stock.includes('listProviderAdapters()'));
  assert(stock.includes('reservationProjection'));
});
check('commerce route does not import provider implementation services', () => {
  assert(!/require\(['"]\.\.\/services\/commerce\/allegro/i.test(route));
  assert(route.includes('executeProviderOperation'));
  assert(route.includes('legacyPublicationOperation'));
});
check('legacy Allegro HTTP aliases dispatch operation IDs instead of service functions', () => {
  assert(route.includes("legacyPublicationOperation('draft.reconcile')"));
  assert(route.includes("legacyPublicationOperation('content.preview')"));
  assert(route.includes("legacyPublicationOperation('health.scan')"));
});
check('integration registry is only a compatibility facade over Provider Core', () => {
  assert(integration.includes("require('./providers/registry')"));
  assert(!/BaseLinkerAccount|AllegroAccount|listBaseLinkerAccounts|listAllegroAccounts/.test(integration));
});
check('one provider registry owns live and planned integrations', () => {
  for (const provider of ['./baseLinker', './allegro', './planned']) assert(registry.includes(`require('${provider}')`));
  assert(registry.includes('getCommerceIntegrationRegistry'));
});
check('provider adapters own reservation projection details', () => {
  assert(allegro.includes('reservationProjection:'));
  assert(allegro.includes('AllegroOrderIndex'));
  assert(baseLinker.includes('reservationProjection:'));
  assert(baseLinker.includes('BaseLinkerOrderIndex'));
  assert(baseLinker.includes('BaseLinkerPickingOrder'));
});
check('publication preview stays provider-neutral', () => {
  assert(!/provider\s*===\s*['"](?:allegro|baselinker|olx|temu)/i.test(preview));
  assert(!/require\(['"].*(?:allegro|baselinker)/i.test(preview));
});
check('durable commerce product/listing models remain provider-neutral', () => {
  for (const source of [product, listing]) {
    assert(!/require\(['"].*(?:allegro|baselinker)/i.test(source));
    assert(!/provider\s*===\s*['"](?:allegro|baselinker|olx|temu)/i.test(source));
  }
});
check('provider operations stay behind the adapter contract', () => {
  assert(allegro.includes("'draft.reconcile':"));
  assert(allegro.includes("'content.preview':"));
  assert(allegro.includes("'health.scan':"));
  assert(registry.includes('adapter.operations'));
});

if (passed !== checks.length) {
  console.error(`Commerce provider isolation firewall: FAIL (${passed}/${checks.length})`);
  process.exit(1);
}
console.log(`Commerce provider isolation firewall: PASS (${passed}/${checks.length})`);
