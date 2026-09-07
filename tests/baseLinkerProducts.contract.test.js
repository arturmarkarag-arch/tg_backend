const {
  catalogKeyForOrderProduct,
  normalizeImageUrls,
  fetchBaseLinkerProductCatalog,
} = require('../services/baseLinkerProducts');

describe('BaseLinker product catalog enrichment', () => {
  it('namespaces a stable catalog key by our BaseLinker account UUID', () => {
    expect(catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }, 'A'))
      .toBe('A:shop:2445:524');
    expect(catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }, 'B'))
      .toBe('B:shop:2445:524');
    expect(() => catalogKeyForOrderProduct({ storage: 'shop', storage_id: 2445, product_id: '524' }))
      .toThrow();
  });

  it('prefers default inventory gallery images and removes duplicates', () => {
    expect(normalizeImageUrls({
      2: 'https://cdn/two.jpg',
      1: 'https://cdn/one.jpg',
      '1|allegro_123': 'https://cdn/channel.jpg',
      3: 'https://cdn/one.jpg',
    })).toEqual(['https://cdn/one.jpg', 'https://cdn/two.jpg', 'https://cdn/channel.jpg']);
  });

  it('loads external shop product details/photos in one storage-aware lookup inside that account namespace', async () => {
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
      baseLinkerAccountId: 'A',
      order_id: 1,
      products: [{ storage: 'shop', storage_id: 2445, product_id: '524', order_product_id: 10 }],
    }], callApi);

    expect(calls).toEqual([{
      method: 'getExternalStorageProductsData',
      params: { storage_id: 'shop_2445', products: ['524'] },
    }]);
    expect(result.productCatalog['A:shop:2445:524'].images).toEqual(['https://cdn/product.jpg']);
    expect(result.productCatalogStats.resolved).toBe(1);
  });

  it('uses exact inventory product data for Base inventory lines', async () => {
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
      baseLinkerAccountId: 'A',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], callApi);

    expect(calls[0].method).toBe('getInventoryProductsData');
    expect(calls[0].params.inventory_id).toBe(307);
    expect(calls[0].params.include_channels_media).toBe(false);
    expect(result.productCatalog['A:db:307:2685'].images).toEqual(['https://cdn/base.jpg']);
  });

  it('fails closed when an ordered Base product has no exact inventory id instead of scanning inventories heuristically', async () => {
    const callApi = vi.fn(async () => {
      throw new Error('upstream must not be called without exact storage_id');
    });

    const result = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'A',
      products: [{ storage: 'db', storage_id: 0, product_id: 2685 }],
    }], callApi);

    expect(callApi).not.toHaveBeenCalled();
    expect(result.productCatalog['A:db:0:2685']).toEqual({ state: 'unresolved_exact_source', images: [] });
  });

  it('keeps identical BaseLinker product ids from two accounts in separate cache keys', async () => {
    const calls = { 'account-A': 0, 'account-B': 0 };
    const makeCaller = (accountId) => async (method) => {
      calls[accountId] += 1;
      expect(method).toBe('getInventoryProductsData');
      return {
        status: 'SUCCESS',
        products: {
          2685: { images: { 1: `https://cdn/${accountId}.jpg` } },
        },
      };
    };

    const resultA = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'account-A',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], makeCaller('account-A'));
    const resultB = await fetchBaseLinkerProductCatalog([{
      baseLinkerAccountId: 'account-B',
      products: [{ storage: 'db', storage_id: 307, product_id: 2685 }],
    }], makeCaller('account-B'));

    expect(resultA.productCatalog['account-A:db:307:2685'].images).toEqual(['https://cdn/account-A.jpg']);
    expect(resultB.productCatalog['account-B:db:307:2685'].images).toEqual(['https://cdn/account-B.jpg']);
    expect(resultA.productCatalog['account-B:db:307:2685']).toBeUndefined();
    expect(resultB.productCatalog['account-A:db:307:2685']).toBeUndefined();
  });
});
