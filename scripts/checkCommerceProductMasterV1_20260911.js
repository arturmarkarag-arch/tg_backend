'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function assert(condition, label) {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

const product = read('models/CommerceProduct.js');
const category = read('models/CommerceCategory.js');
const master = read('services/commerce/productMaster.js');
const catalog = read('services/commerce/catalog.js');
const routes = read('routes/commerce.js');
const productsRoute = read('routes/products.js');
const providerReadme = read('services/commerce/PRODUCT_MASTER_CONTRACT.md');

assert(exists('models/CommerceCategory.js') && exists('services/commerce/productMaster.js'), 'Product Master runtime modules exist');
assert(/identifiers/.test(product) && /attributeValues/.test(product) && /physical/.test(product) && /categoryId/.test(product), 'canonical identity taxonomy attributes physical fields exist');
assert(/role.*primary/.test(product) && /position/.test(product), 'media contract has primary/gallery ordering');
assert(!/allegro|olx|temu/i.test(product), 'CommerceProduct model has no provider-specific fields');
assert(/CommerceInventoryItem/.test(catalog) && /availableStock:\s*onHand/.test(catalog), 'Commerce inventory remains the online stock source');
assert(/Product\.quantity.*never|never.*Product\.quantity/i.test(providerReadme), 'contract forbids main warehouse quantity as live Commerce stock');
assert(/router\.get\('\/categories'/.test(routes) && /router\.post\('\/categories'/.test(routes), 'provider-neutral Commerce category API exists');
assert(/computeProductMasterReadiness/.test(catalog) && /PRODUCT_MASTER_CONTRACT_VERSION/.test(master), 'computed Product Master readiness is versioned');
assert(/thumbPublicUrl/.test(productsRoute) && /r2PublicUrl\(folder, filename\)/.test(productsRoute), 'R2 pair upload exposes public URLs for Product Master media');
assert(/legacy.*ean|compatibility/i.test(product) && /legacyEanFromIdentifiers/.test(catalog), 'legacy EAN remains compatible while identifiers are canonical');
assert(/Provider adapters translate this contract/.test(providerReadme), 'Product Master provider boundary is documented');

console.log('Commerce Product Master v1 backend: 11/11 PASS');
