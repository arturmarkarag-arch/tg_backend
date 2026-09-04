const {
  catalogKeyForOrderProduct,
  normalizeImageUrls,
  fetchBaseLinkerProductCatalog,
} = require('../services/baseLinkerProducts');

describe('BaseLinker product catalog enrichment', () => {
  it('keeps a stable catalog key from the order-line source identifiers', () => {
    expect(catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }))
      .toBe('shop:2445:524');
  });

  it('prefers default inventory gallery images and removes duplicates', () => {
    expect(normalizeImageUrls({
      2: 'https://cdn/two.jpg',
      1: 'https://cdn/one.jpg',
      '1|allegro_123': 'https://cdn/channel.jpg',
      3: 'https://cdn/one.jpg',
    })).toEqual(['https://cdn/one.jpg', 'https://cdn/two.jpg', 'https://cdn/channel.jpg']);
  });

  it('loads external shop product details/photos in one storage-aware lookup', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getExternalStorageProductsData') {
        return {
          status: 'SUCCESS',
          products: {
            524: { product_id: 524, name: 'Product', images: ['https://cdn/product.jpg'] },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      order_id: 1,
      products: [{ storage: 'shop', storage_id: 2445, product_id: '524', order_product_id: 10 }],
    }], callApi);

    expect(calls).toEqual([{
      method: 'getExternalStorageProductsData',
      params: { storage_id: 'shop_2445', products: ['524'] },
    }]);
    expect(result.productCatalog['shop:2445:524'].images).toEqual(['https://cdn/product.jpg']);
    expect(result.productCatalogStats.resolved).toBe(1);
  });

  it('uses inventory product data for Base inventory lines', async () => {
    const calls = [];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      if (method === 'getInventoryProductsData') {
        return {
          status: 'SUCCESS',
          products: {
            2685: { sku: 'EPL-432', images: { 1: 'https://cdn/base.jpg' }, variants: {} },
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], callApi);

    expect(calls[0].method).toBe('getInventoryProductsData');
    expect(calls[0].params.inventory_id).toBe(307);
    expect(calls[0].params.include_channels_media).toBe(true);
    expect(result.productCatalog['db:307:2685'].images).toEqual(['https://cdn/base.jpg']);
  });

  it('can resolve a Base product with missing inventory id by exact product-id scan', async () => {
    const callApi = async (method, params) => {
      if (method === 'getInventories') {
        return { status: 'SUCCESS', inventories: [{ inventory_id: 306 }, { inventory_id: 307 }] };
      }
      if (method === 'getInventoryProductsData' && params.inventory_id === 306) {
        return { status: 'SUCCESS', products: {} };
      }
      if (method === 'getInventoryProductsData' && params.inventory_id === 307) {
        return { status: 'SUCCESS', products: { 2685: { images: { 1: 'https://cdn/found.jpg' } } } };
      }
      throw new Error(`unexpected ${method}`);
    };

    const result = await fetchBaseLinkerProductCatalog([{
      products: [{ storage: 'db', storage_id: 0, product_id: 2685 }],
    }], callApi);

    expect(result.productCatalog['db:0:2685'].inventoryId).toBe(307);
    expect(result.productCatalog['db:0:2685'].lookupMode).toBe('inventory_scan');
  });
});
