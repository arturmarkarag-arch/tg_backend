'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const products = read('services/baseLinkerProducts.js');
const index = read('services/baseLinkerOrderIndex.js');
const dto = read('services/baseLinkerPublicDto.js');
const routes = read('routes/baseLinker.js');
const checks = [
  ['linked products are batched in chunks of 100', products.includes('const LOOKUP_CHUNK_SIZE = 100') && products.includes('for (const ids of chunk(Array.from(byProductId.keys())))')],
  ['db inventory photos use one getInventoryProductsData batch per inventory/chunk', products.includes("callApi('getInventoryProductsData'") && products.includes('inventory_id: inventoryId') && products.includes('products: ids.map')],
  ['channel media is requested in the same product-data call', products.includes('include_channels_media: true')],
  ['central poll resolves only product_id-linked rows', index.includes('{ maxRequests: FULL_SCAN_PRODUCT_WARM_REQUESTS, linkedOnly: true }') && products.includes('const warmRefs = linkedOnly ? refs.filter((ref) => ref.productId) : refs')],
  ['cache prevents repeated product-data calls while fresh', products.includes('PERSISTED_PRODUCT_CACHE_TTL_MS') && products.includes('staleKeys') && products.includes('BaseLinkerProductImageCache.bulkWrite')],
  ['queue preview persists ready-to-render image_url', index.includes('getOrdersWithCachedProductImages(rows.map((row) => row.preview))') && dto.includes("setIfDefined(out, 'image_url', product.image_url)" )],
  ['worker read joins only local cached images', routes.includes('getOrdersWithCachedProductImages(inputOrders)') && !routes.includes('compactProductCatalog(catalog.productCatalog')],
  ['separate productCatalog map is not part of the normal response contract', !routes.includes('productCatalog: compactProductCatalog')],
];
let pass = 0;
for (const [name, ok] of checks) {
  if (!ok) { console.error(`FAIL ${name}`); process.exitCode = 1; }
  else { console.log(`PASS ${name}`); pass += 1; }
}
console.log(`\n${pass}/${checks.length} BaseLinker batch-image contract checks passed`);
