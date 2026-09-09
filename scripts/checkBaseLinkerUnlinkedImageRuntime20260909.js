'use strict';
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './baseLinkerClient' && parent?.filename?.endsWith(path.join('services', 'baseLinkerProducts.js'))) {
    return { makeBaseLinkerAccountCaller: () => { throw new Error('unexpected account caller'); } };
  }
  if (request === '../models/BaseLinkerProductImageCache' && parent?.filename?.endsWith(path.join('services', 'baseLinkerProducts.js'))) {
    return {
      createIndexes: async () => {},
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      bulkWrite: async () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  catalogKeyForOrderProduct,
  fetchBaseLinkerProductCatalog,
  attachProductImagesToOrders,
} = require('../services/baseLinkerProducts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

(async () => {
  const dbCalls = [];
  const dbOrder = {
    baseLinkerAccountId: 'acct-1',
    order_id: 9001,
    order_source: 'amazon',
    order_source_id: 77,
    products: [{
      storage: 'db', storage_id: 12, order_product_id: 501, product_id: '',
      name: 'Exact Red Mug 330 ml', sku: 'MUG-RED-330', ean: '5900000000001', auction_id: '',
    }],
  };
  const dbCatalog = await fetchBaseLinkerProductCatalog([dbOrder], async (method, params) => {
    dbCalls.push([method, params]);
    if (method === 'getInventoryProductsList') {
      return { products: { '7001': { id: 7001, sku: 'MUG-RED-330', ean: '5900000000001', name: 'Exact Red Mug 330 ml' } } };
    }
    if (method === 'getInventoryProductsData') {
      return { products: { '7001': { images: { '1': 'https://cdn.example/db.jpg' }, media_options: {} } } };
    }
    throw new Error(`unexpected db method ${method}`);
  });
  const dbKey = catalogKeyForOrderProduct(dbOrder.products[0], 'acct-1', 'amazon', 9001);
  assert(dbKey === 'acct-1:order:9001:line:501', 'blank product_id gets a stable exact order-line cache key');
  assert(dbCatalog.productCatalog[dbKey]?.images?.[0] === 'https://cdn.example/db.jpg', 'blank product_id resolves from exact Base inventory storage');
  assert(dbCalls.map(([m]) => m).join(',') === 'getInventoryProductsList,getInventoryProductsData', 'Base inventory fallback uses bounded list + data lookup');
  const dbAttached = attachProductImagesToOrders([dbOrder], dbCatalog.productCatalog);
  assert(dbAttached[0].products[0].image_url === 'https://cdn.example/db.jpg', 'resolved unlinked image is attached to queue order preview');

  const extCalls = [];
  const extOrder = {
    baseLinkerAccountId: 'acct-1',
    order_id: 9002,
    order_source: 'shop',
    order_source_id: 22,
    products: [{
      storage: 'shop', storage_id: 2445, order_product_id: 502, product_id: '',
      name: 'External Blue Bowl', sku: 'BOWL-BLUE', ean: '', auction_id: '',
    }],
  };
  const extCatalog = await fetchBaseLinkerProductCatalog([extOrder], async (method, params) => {
    extCalls.push([method, params]);
    if (method === 'getProductsList') {
      return { products: [{ product_id: '8801', sku: 'BOWL-BLUE', ean: '', name: 'External Blue Bowl' }] };
    }
    if (method === 'getProductsData') {
      return { products: { '8801': { images: ['https://cdn.example/shop.jpg'] } } };
    }
    throw new Error(`unexpected external method ${method}`);
  });
  const extKey = catalogKeyForOrderProduct(extOrder.products[0], 'acct-1', 'shop', 9002);
  assert(extCatalog.productCatalog[extKey]?.images?.[0] === 'https://cdn.example/shop.jpg', 'blank product_id resolves from exact connected shop storage');
  assert(extCalls[0][1].storage_id === 'shop_2445', 'external lookup preserves exact BaseLinker storage identity');

  const ambiguousOrder = {
    baseLinkerAccountId: 'acct-1', order_id: 9003, order_source: 'amazon', order_source_id: 77,
    products: [{ storage: 'db', storage_id: 12, order_product_id: 503, product_id: '', name: 'Same Name', sku: 'DUP', ean: '' }],
  };
  const ambiguous = await fetchBaseLinkerProductCatalog([ambiguousOrder], async (method) => {
    if (method === 'getInventoryProductsList') {
      return { products: {
        '1': { id: 1, sku: 'DUP', name: 'Same Name' },
        '2': { id: 2, sku: 'DUP', name: 'Same Name' },
      } };
    }
    throw new Error(`should not fetch product data after ambiguous match: ${method}`);
  });
  const ambKey = catalogKeyForOrderProduct(ambiguousOrder.products[0], 'acct-1', 'amazon', 9003);
  assert(ambiguous.productCatalog[ambKey]?.state === 'unlinked_storage_not_unique', 'ambiguous unlinked match fails closed instead of guessing a photo');

  console.log('\n7/7 BaseLinker unlinked image runtime checks passed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
